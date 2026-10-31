import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// Covers that are not interactive controls (PILOT-979) and fixed chrome a
// tap can scroll its target clear of (PILOT-980). Every target counts its
// own taps, and so does every cover, so a test can tell where a touch went.
//
// - "Behind loading" sits under a loading overlay: a plain see-through view
//   holding an ActivityIndicator, with no onPress of its own. It swallows
//   touches as any view does (and counts them), but nothing in it is a
//   control. "Load briefly" shows it for 1.5 s; "Keep loading" until toggled.
// - The list has a sticky header (stickyHeaderIndices) that stays at the top
//   while rows scroll under it, and a "Footer action" button fixed over the
//   bottom of the list, as a checkout bar is. "Put row 5 under header"
//   scrolls so row 5 sits exactly under the header.

const ROW_HEIGHT = 60
const ROWS = Array.from({ length: 30 }, (_, i) => `Row ${i + 1}`)
type Item = { key: string; header: boolean }
const ITEMS: Item[] = [
  { key: "Sticky header", header: true },
  ...ROWS.map((key) => ({ key, header: false })),
]

export default function CoversScreen() {
  const [loading, setLoading] = useState(false)
  const [behindLoadingTaps, setBehindLoadingTaps] = useState(0)
  const [loadingOverlayTaps, setLoadingOverlayTaps] = useState(0)
  const [lastRow, setLastRow] = useState("none")
  const [rowTaps, setRowTaps] = useState(0)
  const [footerTaps, setFooterTaps] = useState(0)
  const [headerTaps, setHeaderTaps] = useState(0)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const list = useRef<FlatList<Item>>(null)

  // A warm reset navigates here rather than remounting, so clear local state
  // explicitly when the epoch moves.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    clearTimeout(hideTimer.current)
    setLoading(false)
    setBehindLoadingTaps(0)
    setLoadingOverlayTaps(0)
    setLastRow("none")
    setRowTaps(0)
    setFooterTaps(0)
    setHeaderTaps(0)
    list.current?.scrollToOffset({ offset: 0, animated: false })
  }, [resetEpoch])
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const loadBriefly = () => {
    setLoading(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setLoading(false), 1500)
  }

  return (
    <View style={styles.container}>
      <Text testID="covers-counts" style={styles.counts}>
        {`behindLoading=${behindLoadingTaps} loadingOverlay=${loadingOverlayTaps} row=${lastRow} rowTaps=${rowTaps} header=${headerTaps} footer=${footerTaps}`}
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
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => list.current?.scrollToOffset({ offset: 5 * ROW_HEIGHT, animated: false })}
          accessibilityRole="button"
          accessibilityLabel="Put row 5 under header"
        >
          <Text style={styles.smallButtonText}>Row 5 under header</Text>
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

      <View style={styles.listArea}>
        <FlatList
          ref={list}
          data={ITEMS}
          stickyHeaderIndices={[0]}
          testID="covers-list"
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) =>
            item.header ? (
              <View
                style={styles.header}
                testID="sticky-header"
                onStartShouldSetResponder={() => true}
                onResponderRelease={() => setHeaderTaps((n) => n + 1)}
              >
                <Text style={styles.headerText}>Sticky header</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.row}
                onPress={() => {
                  setLastRow(item.key)
                  setRowTaps((n) => n + 1)
                }}
                accessibilityRole="button"
                accessibilityLabel={item.key}
              >
                <Text style={styles.rowText}>{item.key}</Text>
              </TouchableOpacity>
            )
          }
        />
        <TouchableOpacity
          style={styles.footer}
          onPress={() => setFooterTaps((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Footer action"
        >
          <Text style={styles.buttonText}>Footer action</Text>
        </TouchableOpacity>
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
  listArea: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 80,
  },
  header: {
    height: ROW_HEIGHT,
    backgroundColor: "#333",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  headerText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  row: {
    height: ROW_HEIGHT,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#ddd",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  rowText: {
    fontSize: 16,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 80,
    backgroundColor: "#34C759",
    alignItems: "center",
    justifyContent: "center",
  },
})
