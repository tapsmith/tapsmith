import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// Covers that are not interactive controls (PILOT-979). The target counts its
// own taps, and so does the cover, so a test can tell where a touch went.
//
// - "Behind loading" sits under a loading overlay: a plain see-through view
//   holding an ActivityIndicator, with no onPress of its own. It swallows
//   touches as any view does (and counts them), but nothing in it is a
//   control. "Load briefly" shows it for 3 s; "Keep loading" until toggled.

export default function CoversScreen() {
  const [loading, setLoading] = useState(false)
  const [behindLoadingTaps, setBehindLoadingTaps] = useState(0)
  const [loadingOverlayTaps, setLoadingOverlayTaps] = useState(0)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // A warm reset navigates here rather than remounting, so clear local state
  // explicitly when the epoch moves.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    clearTimeout(hideTimer.current)
    setLoading(false)
    setBehindLoadingTaps(0)
    setLoadingOverlayTaps(0)
  }, [resetEpoch])
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const loadBriefly = () => {
    setLoading(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setLoading(false), 3000)
  }

  return (
    <View style={styles.container}>
      <Text testID="covers-counts" style={styles.counts}>
        {`behindLoading=${behindLoadingTaps} loadingOverlay=${loadingOverlayTaps}`}
      </Text>

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={loadBriefly}
          accessibilityRole="button"
          accessibilityLabel="Load briefly"
        >
          <Text style={styles.smallButtonText}>Load briefly</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => {
            clearTimeout(hideTimer.current)
            setLoading((l) => !l)
          }}
          accessibilityRole="button"
          accessibilityLabel={loading ? "Stop loading" : "Keep loading"}
        >
          <Text style={styles.smallButtonText}>{loading ? "Stop loading" : "Keep loading"}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.stack}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setBehindLoadingTaps((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Behind loading"
        >
          <Text style={styles.buttonText}>Behind loading</Text>
        </TouchableOpacity>
        {loading && (
          <View
            style={styles.loadingOverlay}
            testID="loading-overlay"
            onStartShouldSetResponder={() => true}
            onResponderRelease={() => setLoadingOverlayTaps((n) => n + 1)}
          >
            <ActivityIndicator color="#333" />
          </View>
        )}
      </View>
    </View>
  )
}

const fill = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
    backgroundColor: "#f5f5f5",
  },
  counts: {
    fontSize: 12,
  },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
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
  loadingOverlay: {
    ...fill,
    backgroundColor: "rgba(255, 255, 255, 0.6)",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
})
