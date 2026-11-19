import { useRef, useState } from "react"
import {
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native"

const SIZES = ["Small", "Medium", "Large"]

// Gestures that must land where they are aimed when the screen is turned.
// On a wide screen the controls sit in a column at the left and the pad
// fills the rest, so the pad holds the screen's centre (a device.swipe()
// starts there) and lies past the native portrait screen's width: a gesture
// pressed at its interface points as if they were portrait ones lands off
// the screen. The pad reports what reached it: a tap, a swipe and its
// direction, or a pinch and whether it opened or closed.
export default function TurnedScreen() {
  const { width, height } = useWindowDimensions()
  const wide = width > height
  // Counted, as a warm reset keeps the screen's state across tests: a test
  // tells its own gesture from an earlier one by the count.
  const [pad, setPad] = useState({ count: 0, gesture: "None" })
  const [sizesOpen, setSizesOpen] = useState(false)
  const [size, setSize] = useState("None")
  const [text, setText] = useState("")

  // The gesture under way: the most fingers seen at once, and the first and
  // last distance between two of them.
  const gesture = useRef({ fingers: 0, firstSpan: 0, lastSpan: 0 })

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (evt) => {
        gesture.current = { fingers: 0, firstSpan: 0, lastSpan: 0 }
        track(evt)
      },
      onPanResponderMove: (evt) => track(evt),
      onPanResponderRelease: (_evt, state) => {
        const g = gesture.current
        let name: string
        if (g.fingers >= 2) {
          name = g.lastSpan > g.firstSpan ? "pinch out" : "pinch in"
        } else if (Math.max(Math.abs(state.dx), Math.abs(state.dy)) < 20) {
          name = "tap"
        } else if (Math.abs(state.dx) > Math.abs(state.dy)) {
          name = state.dx < 0 ? "swipe left" : "swipe right"
        } else {
          name = state.dy < 0 ? "swipe up" : "swipe down"
        }
        setPad((p) => ({ count: p.count + 1, gesture: name }))
      },
    }),
  ).current

  function track(evt: GestureResponderEvent) {
    const touches = evt.nativeEvent.touches
    const g = gesture.current
    g.fingers = Math.max(g.fingers, touches.length)
    if (touches.length >= 2) {
      const span = Math.hypot(
        touches[0].pageX - touches[1].pageX,
        touches[0].pageY - touches[1].pageY,
      )
      if (g.firstSpan === 0) g.firstSpan = span
      g.lastSpan = span
    }
  }

  return (
    <View style={[styles.container, wide && styles.wide]}>
      <View style={[styles.controls, wide && styles.wideControls]}>
        <Text style={styles.status} testID="turned-pad-result">
          Pad {pad.count}: {pad.gesture}
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setSizesOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel="Pick a size"
          testID="turned-size"
        >
          <Text style={styles.buttonText}>Pick a size</Text>
        </TouchableOpacity>
        {sizesOpen &&
          SIZES.map((name) => (
            <TouchableOpacity
              key={name}
              style={styles.option}
              // Not one accessible element: the option is found by its text,
              // as a dropdown's options are.
              accessible={false}
              onPress={() => {
                setSize(name)
                setSizesOpen(false)
              }}
            >
              <Text style={styles.optionText}>{name}</Text>
            </TouchableOpacity>
          ))}
        <Text style={styles.status} testID="turned-size-chosen">
          Size: {size}
        </Text>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Turned field"
          accessibilityLabel="Turned field"
          testID="turned-field"
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <View
        style={styles.pad}
        {...responder.panHandlers}
        accessible
        accessibilityLabel="Gesture pad"
        testID="turned-pad"
      >
        <Text style={styles.padText}>Tap, swipe or pinch here</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 16,
  },
  wide: {
    flexDirection: "row",
  },
  controls: {
    marginBottom: 12,
  },
  wideControls: {
    width: "30%",
    marginBottom: 0,
    marginRight: 12,
  },
  status: {
    fontSize: 16,
    color: "#333",
    marginBottom: 8,
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    padding: 10,
    alignItems: "center",
    marginBottom: 8,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
  },
  option: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ccc",
  },
  optionText: {
    fontSize: 16,
    color: "#333",
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 8,
    fontSize: 16,
  },
  pad: {
    flex: 1,
    backgroundColor: "#e8f0fe",
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  padText: {
    color: "#555",
  },
})
