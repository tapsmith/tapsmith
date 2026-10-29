import { useEffect, useRef, useState } from "react"
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native"

// The window is measured between JS onPress callbacks (not touch
// timestamps), so it must absorb JS-thread/bridge scheduling jank on
// loaded CI runners: touches injected 120ms apart at the HID layer were
// observed reaching JS >450ms apart there. Every deliberate double-tap
// the framework synthesizes keeps its taps ≤250ms apart, and the tests
// never issue two intentional single taps within a second, so a wide
// window stays unambiguous.
const DOUBLE_TAP_WINDOW_MS = 800

export default function GesturesScreen() {
  const [lastGesture, setLastGesture] = useState("None")
  const [tapCount, setTapCount] = useState(0)
  const [longPressed, setLongPressed] = useState(false)

  const pendingSingleTapRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (pendingSingleTapRef.current) {
        clearTimeout(pendingSingleTapRef.current)
      }
    }
  }, [])

  const handleTap = () => {
    setTapCount((c) => c + 1)

    if (pendingSingleTapRef.current) {
      clearTimeout(pendingSingleTapRef.current)
      pendingSingleTapRef.current = null
      setLastGesture("Double tap")
      return
    }

    pendingSingleTapRef.current = setTimeout(() => {
      setLastGesture("Single tap")
      pendingSingleTapRef.current = null
    }, DOUBLE_TAP_WINDOW_MS)
  }

  const pan = useRef(new Animated.ValueXY()).current

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pan.setOffset({
          x: (pan.x as unknown as { _value: number })._value,
          y: (pan.y as unknown as { _value: number })._value,
        })
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: () => {
        pan.flattenOffset()
        setLastGesture("Drag")
      },
    }),
  ).current

  // Two-finger pinch (PILOT-825): the fingers' distance when two first touch,
  // and at their last move. Reported on release as a pinch in or out, so a
  // test sees whether the app read a real pinch.
  const pinchSpan = useRef<{ first: number; last: number } | null>(null)

  const pinchResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (evt) => {
        const touches = evt.nativeEvent.touches
        if (touches.length < 2) return
        const span = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY)
        if (pinchSpan.current) {
          pinchSpan.current.last = span
        } else {
          pinchSpan.current = { first: span, last: span }
        }
      },
      onPanResponderRelease: () => {
        const span = pinchSpan.current
        pinchSpan.current = null
        if (!span) return
        if (span.last < span.first * 0.9) setLastGesture("Pinch in")
        else if (span.last > span.first * 1.1) setLastGesture("Pinch out")
      },
      onPanResponderTerminate: () => {
        pinchSpan.current = null
      },
    }),
  ).current

  return (
    <View style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Gesture Testing
      </Text>

      <Text style={styles.statusText} testID="last-gesture">
        Last gesture: {lastGesture}
      </Text>
      <Text style={styles.statusText} testID="tap-count">
        Tap count: {tapCount}
      </Text>

      <Text style={styles.sectionHeader}>Tap Area</Text>
      <TouchableOpacity
        style={styles.gestureArea}
        onPress={handleTap}
        accessibilityRole="button"
        accessibilityLabel="Tap area"
        testID="tap-area"
      >
        <Text style={styles.gestureText}>Tap or double-tap here</Text>
      </TouchableOpacity>

      <Text style={styles.sectionHeader}>Long Press</Text>
      <TouchableOpacity
        style={[styles.gestureArea, longPressed && styles.gestureAreaActive]}
        onLongPress={() => {
          setLongPressed(true)
          setLastGesture("Long press")
        }}
        onPress={() => setLongPressed(false)}
        accessibilityRole="button"
        accessibilityLabel="Long press area"
        testID="long-press-area"
      >
        <Text style={styles.gestureText}>{longPressed ? "Long pressed!" : "Long press here"}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionHeader}>Drag Area</Text>
      <View style={styles.dragContainer} testID="drag-container">
        <Animated.View
          style={[styles.draggable, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
          {...panResponder.panHandlers}
          accessibilityRole="adjustable"
          accessibilityLabel="Draggable item"
          testID="draggable"
        >
          <Text style={styles.draggableText}>Drag me</Text>
        </Animated.View>

        <View style={styles.dropZone} accessibilityLabel="Drop zone" testID="drop-zone">
          <Text style={styles.dropZoneText}>Drop Zone</Text>
        </View>
      </View>

      <Text style={styles.sectionHeader}>Pinch Area</Text>
      <View
        style={styles.pinchArea}
        accessibilityLabel="Pinch to zoom area"
        testID="pinch-area"
        {...pinchResponder.panHandlers}
      >
        <Text style={styles.gestureText}>Pinch to zoom here</Text>
      </View>

      <Text style={styles.sectionHeader}>Swipe Area</Text>
      <View style={styles.swipeArea} accessibilityLabel="Swipe area" testID="swipe-area">
        <Text style={styles.gestureText}>Swipe in any direction</Text>
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
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 8,
    color: "#1a1a1a",
  },
  sectionHeader: {
    fontSize: 16,
    fontWeight: "600",
    marginTop: 12,
    marginBottom: 6,
    color: "#333",
  },
  statusText: {
    fontSize: 14,
    color: "#666",
    marginBottom: 2,
  },
  gestureArea: {
    backgroundColor: "#E8F4FD",
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#007AFF",
    borderStyle: "dashed",
  },
  gestureAreaActive: {
    backgroundColor: "#34C759",
    borderColor: "#34C759",
  },
  gestureText: {
    fontSize: 16,
    color: "#007AFF",
    fontWeight: "600",
  },
  dragContainer: {
    height: 120,
    backgroundColor: "#fff",
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    overflow: "hidden",
  },
  draggable: {
    width: 80,
    height: 80,
    backgroundColor: "#007AFF",
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  draggableText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 14,
  },
  dropZone: {
    width: 100,
    height: 80,
    backgroundColor: "#f0f0f0",
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#ccc",
    borderStyle: "dashed",
    justifyContent: "center",
    alignItems: "center",
  },
  dropZoneText: {
    color: "#999",
    fontWeight: "600",
  },
  pinchArea: {
    backgroundColor: "#FFF3E0",
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#FF9800",
    borderStyle: "dashed",
  },
  swipeArea: {
    backgroundColor: "#F3E5F5",
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#9C27B0",
    borderStyle: "dashed",
    marginBottom: 32,
  },
})
