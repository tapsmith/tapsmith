import { useRef, useState } from "react"
import { PanResponder, StyleSheet, Text, View } from "react-native"

// Drag and drop that says where the drop landed: on the drop zone or not.
// The Gestures screen's drag only records that a drag happened, and its drag
// row sits below the fold of a landscape phone, so this screen keeps both
// ends near the top, side by side in either orientation.
export default function DragScreen() {
  // Counted, as a warm reset keeps the screen's state across tests: a test
  // tells its own drop from an earlier one by the count.
  const [drop, setDrop] = useState({ count: 0, result: "None" })
  const dropZone = useRef<View>(null)

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderRelease: (evt) => {
        // Where the touch lifted, and the zone, both in page coordinates:
        // window coordinates (measureInWindow) sit below the status bar on
        // Android, which put a drop on the zone's centre outside it. The zone
        // is measured now, not on layout: on layout it can still be sliding
        // in with the screen's push transition, or turning.
        const { pageX, pageY } = evt.nativeEvent
        dropZone.current?.measure((_x, _y, width, height, left, top) => {
          const inside =
            pageX >= left && pageX <= left + width && pageY >= top && pageY <= top + height
          setDrop((d) => ({ count: d.count + 1, result: inside ? "On target" : "Missed" }))
        })
      },
    }),
  ).current

  return (
    <View style={styles.container}>
      <Text style={styles.statusText} testID="drop-result">
        Drop {drop.count}: {drop.result}
      </Text>
      <View style={styles.row}>
        <View
          style={styles.draggable}
          {...responder.panHandlers}
          accessibilityLabel="Drag source"
          testID="drag-source"
        >
          <Text style={styles.draggableText}>Drag me</Text>
        </View>
        <View
          ref={dropZone}
          // Measurable: a view with no layout-only props can be flattened away.
          collapsable={false}
          style={styles.dropZone}
          accessibilityLabel="Drop target"
          testID="drop-target"
        >
          <Text style={styles.dropZoneText}>Drop here</Text>
        </View>
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
  statusText: {
    fontSize: 16,
    color: "#333",
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
})
