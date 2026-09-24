import { useEffect, useRef, useState } from "react"
import {
  KeyboardAvoidingView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// Targets that are on screen but covered by something else (PILOT-223): a tap
// on a covered element must fail, never report success while the touch lands
// on whatever is on top. Every target counts its own taps, and so does every
// cover, so a test can tell which one a touch actually reached.
//
// - "Bottom action" is pinned to the bottom edge with no keyboard avoidance,
//   so focusing the input puts the software keyboard over it. "Tall bottom
//   action" is the same button made tall enough that its top stays above the
//   keyboard while its center is covered.
// - "Covered action" sits under a card-sized overlay that has its own onPress,
//   shown until toggled off or ("Briefly") for 1.5 s. "Cover and replace"
//   shows it for 1.5 s and then swaps "Covered action" for "Replacement
//   action" in the same spot — a target that goes away while its cover is
//   waited out must not get the touch meant for it.
// - "Bottom input" sits just above the bottom action, behind the keyboard
//   once the top input has focus. "Avoid keyboard" lifts the whole screen
//   above the keyboard when it opens, so focusing the bottom input moves it —
//   a refocus aimed at where it was would land on the keyboard.
//   "Tall input" makes it tall enough that its top stays above the keyboard
//   while its center is covered. (Still single-line: a multiline field
//   reaches XCUITest as a text view that drops its testID and label.)
// - "Pass-through action" sits under an overlay with pointerEvents="none",
//   which covers it visually but lets touches through.
// - "terms" is a link nested inside a Text run: it is not a view of its own
//   (iOS 26 still reports it hittable; older runtimes may not).
// - "Cover input" puts a tappable overlay ("Input cover") over the top
//   input. A field that already has focus keeps getting the input under a
//   control on its own screen, so typing into it must not tap the cover.

export default function OcclusionScreen() {
  const [text, setText] = useState("")
  const [tall, setTall] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [bottomTaps, setBottomTaps] = useState(0)
  const [coveredTaps, setCoveredTaps] = useState(0)
  const [overlayTaps, setOverlayTaps] = useState(0)
  const [passThroughTaps, setPassThroughTaps] = useState(0)
  const [linkTaps, setLinkTaps] = useState(0)
  const [replaced, setReplaced] = useState(false)
  const [replacementTaps, setReplacementTaps] = useState(0)
  const [inputCovered, setInputCovered] = useState(false)
  const [inputCoverTaps, setInputCoverTaps] = useState(0)
  const [bottomText, setBottomText] = useState("")
  const [tallInput, setTallInput] = useState(false)
  const [avoidKeyboard, setAvoidKeyboard] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // A warm reset navigates here rather than remounting, so clear local state
  // explicitly when the epoch moves.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setText("")
    setTall(false)
    clearTimeout(hideTimer.current)
    setOverlayVisible(false)
    setBottomTaps(0)
    setCoveredTaps(0)
    setOverlayTaps(0)
    setPassThroughTaps(0)
    setLinkTaps(0)
    setReplaced(false)
    setReplacementTaps(0)
    setInputCovered(false)
    setInputCoverTaps(0)
    setBottomText("")
    setTallInput(false)
    setAvoidKeyboard(false)
  }, [resetEpoch])

  // Covers "Covered action" for 1.5 s, for a tap that has to wait out a
  // transient cover rather than fail on it.
  const showOverlayBriefly = () => {
    setOverlayVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setOverlayVisible(false), 1500)
  }
  const coverAndReplace = () => {
    setOverlayVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setOverlayVisible(false)
      setReplaced(true)
    }, 1500)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      contentContainerStyle={styles.container}
      behavior="position"
      enabled={avoidKeyboard}
    >
      <View>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Type to open the keyboard"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Occlusion input"
          testID="occlusion-input"
        />
        {inputCovered && (
          <TouchableOpacity
            style={styles.overlay}
            onPress={() => setInputCoverTaps((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Input cover"
          >
            <Text style={styles.overlayText}>Input cover</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text testID="occlusion-counts">
        {`bottom=${bottomTaps} covered=${coveredTaps} overlay=${overlayTaps} passThrough=${passThroughTaps} link=${linkTaps} replacement=${replacementTaps} inputCover=${inputCoverTaps}`}
      </Text>

      <View style={styles.row}>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => setTall((t) => !t)}
          accessibilityRole="button"
          accessibilityLabel={tall ? "Make bottom action short" : "Make bottom action tall"}
        >
          <Text style={styles.smallButtonText}>{tall ? "Short" : "Tall"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => setOverlayVisible((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={overlayVisible ? "Hide overlay" : "Show overlay"}
        >
          <Text style={styles.smallButtonText}>
            {overlayVisible ? "Hide overlay" : "Show overlay"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={showOverlayBriefly}
          accessibilityRole="button"
          accessibilityLabel="Show overlay briefly"
        >
          <Text style={styles.smallButtonText}>Briefly</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => setTallInput((t) => !t)}
          accessibilityRole="button"
          accessibilityLabel={tallInput ? "Make bottom input short" : "Make bottom input tall"}
        >
          <Text style={styles.smallButtonText}>{tallInput ? "Short input" : "Tall input"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => setAvoidKeyboard((a) => !a)}
          accessibilityRole="button"
          accessibilityLabel={avoidKeyboard ? "Stop avoiding keyboard" : "Avoid keyboard"}
        >
          <Text style={styles.smallButtonText}>{avoidKeyboard ? "Overlap" : "Avoid"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={coverAndReplace}
          accessibilityRole="button"
          accessibilityLabel="Cover and replace"
        >
          <Text style={styles.smallButtonText}>Replace</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => setInputCovered((c) => !c)}
          accessibilityRole="button"
          accessibilityLabel={inputCovered ? "Uncover input" : "Cover input"}
        >
          <Text style={styles.smallButtonText}>{inputCovered ? "Uncover input" : "Cover input"}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.stack}>
        {replaced ? (
          <TouchableOpacity
            style={styles.button}
            onPress={() => setReplacementTaps((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Replacement action"
          >
            <Text style={styles.buttonText}>Replacement action</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={styles.button}
            onPress={() => setCoveredTaps((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Covered action"
          >
            <Text style={styles.buttonText}>Covered action</Text>
          </TouchableOpacity>
        )}
        {overlayVisible && (
          <TouchableOpacity
            style={styles.overlay}
            onPress={() => setOverlayTaps((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Overlay"
          >
            <Text style={styles.overlayText}>Overlay</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.stack}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setPassThroughTaps((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Pass-through action"
        >
          <Text style={styles.buttonText}>Pass-through action</Text>
        </TouchableOpacity>
        <View
          style={styles.passThroughOverlay}
          pointerEvents="none"
          testID="pass-through-overlay"
        />
      </View>

      <Text style={styles.body}>
        Read the{" "}
        <Text
          style={styles.link}
          onPress={() => setLinkTaps((n) => n + 1)}
          accessibilityRole="link"
        >
          terms
        </Text>{" "}
        before continuing.
      </Text>

      <TextInput
        style={[styles.input, styles.bottomInput, tallInput && styles.bottomInputTall]}
        value={bottomText}
        onChangeText={setBottomText}
        placeholder="Behind the keyboard"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Bottom input"
        testID="bottom-input"
      />

      <TouchableOpacity
        style={[styles.bottomButton, tall && styles.bottomButtonTall]}
        onPress={() => setBottomTaps((n) => n + 1)}
        accessibilityRole="button"
        accessibilityLabel={tall ? "Tall bottom action" : "Bottom action"}
      >
        <Text style={styles.buttonText}>{tall ? "Tall bottom action" : "Bottom action"}</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  )
}

const fill = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const

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
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  smallButton: {
    backgroundColor: "#555",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  smallButtonText: {
    color: "#fff",
    fontSize: 14,
  },
  stack: {
    height: 56,
  },
  button: {
    ...fill,
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
  overlay: {
    ...fill,
    backgroundColor: "rgba(200, 30, 30, 0.9)",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  overlayText: {
    color: "#fff",
    fontSize: 16,
  },
  passThroughOverlay: {
    ...fill,
    backgroundColor: "rgba(255, 255, 255, 0.4)",
    borderRadius: 8,
  },
  body: {
    fontSize: 16,
  },
  link: {
    color: "#007AFF",
    textDecorationLine: "underline",
  },
  bottomButton: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 24,
    height: 56,
    backgroundColor: "#34C759",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomInput: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 96,
  },
  bottomInputTall: {
    height: 300,
  },
  bottomButtonTall: {
    height: 400,
  },
})
