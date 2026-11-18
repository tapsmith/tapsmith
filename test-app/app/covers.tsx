import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  Animated,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// Covers that are not interactive controls (PILOT-979) and fixed chrome a
// tap can scroll its target clear of (PILOT-980). Every target counts its
// own taps, and so does every cover, so a test can tell where a touch went.
//
// - "Behind loading" sits under a loading overlay: a plain see-through view
//   holding an ActivityIndicator, with no onPress of its own. It swallows
//   touches as any view does (and counts them), but nothing in it is a
//   control. "Load briefly" shows it for 1.5 s; "Keep loading" until toggled.
// - The list has a "Header action" bar laid over its top (a translucent
//   header the rows scroll under) and a "Footer action" button fixed over its
//   bottom, as a checkout bar is; both sit outside the list. "Put row 5 under
//   header" scrolls so row 5 sits exactly under the header bar.
// - Every row also has an "Add" button, all with the same name: a locator
//   picks one by position (nth), which the iOS agent cannot follow through a
//   scroll, so there it is waited out instead of scrolled clear.
// - "Show dialog" lays a hand-rolled dialog over the whole screen: one host
//   holding a role-less backdrop (a responder, as many apps build one) that
//   closes the dialog when pressed (fading it out over 300 ms, as dialog
//   libraries do, so its views are still there for a moment), and a card. A tap on a row under the
//   footer must not drag from the backdrop and then tap the row.
// - A "Scrolled" label appears in the corner once the list has scrolled, as
//   "back to top" buttons do: something outside the list that the scroll
//   brings in must not stop a scroll-clear.
// - Every row shares the testID "covers-row", as list rows often do, so a
//   row is told apart by its name alone.
// - A "Note" text field sits in the list after Row 12. "Put note under
//   header" scrolls it to the top of the list, under the header bar, so
//   typing into it needs its focusing tap scrolled clear first. "Put note
//   under footer" puts it under the footer instead, for iOS, whose
//   accessibility tree lists the header bar before the list it is laid over
//   (top to bottom), so the iOS agent cannot tell it is on top. (Android
//   uses the header: a field under the footer would, once focused, sit under
//   its own keyboard, and Android hides a field its keyboard covers from the
//   tree.)

const ROW_HEIGHT = 60
const ROWS = Array.from({ length: 30 }, (_, i) => `Row ${i + 1}`)
// The header bar's height: the list's content starts below it.
const HEADER_HEIGHT = 60
const FOOTER_HEIGHT = 80
type Item = { key: string; note?: boolean }
const ITEMS: Item[] = [
  ...ROWS.slice(0, 12).map((key) => ({ key })),
  { key: "Note", note: true },
  ...ROWS.slice(12).map((key) => ({ key })),
]
const NOTE_INDEX = ITEMS.findIndex((item) => item.note)
/** The scroll offset that puts item `index` at the top of the list, under the header bar. */
const offsetUnderHeader = (index: number) => HEADER_HEIGHT + index * ROW_HEIGHT

export default function CoversScreen() {
  const [loading, setLoading] = useState(false)
  const [behindLoadingTaps, setBehindLoadingTaps] = useState(0)
  const [loadingOverlayTaps, setLoadingOverlayTaps] = useState(0)
  const [lastRow, setLastRow] = useState("none")
  const [rowTaps, setRowTaps] = useState(0)
  const [lastAdded, setLastAdded] = useState("none")
  const [footerTaps, setFooterTaps] = useState(0)
  const [headerTaps, setHeaderTaps] = useState(0)
  const [note, setNote] = useState("")
  const [dialog, setDialog] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const dialogOpacity = useRef(new Animated.Value(1)).current
  const closeDialog = () =>
    Animated.timing(dialogOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() =>
      setDialog(false),
    )
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const list = useRef<FlatList<Item>>(null)
  const listHeight = useRef(0)

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
    setLastAdded("none")
    setFooterTaps(0)
    setHeaderTaps(0)
    setNote("")
    setDialog(false)
    setScrolled(false)
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
        {`behindLoading=${behindLoadingTaps} loadingOverlay=${loadingOverlayTaps} row=${lastRow} rowTaps=${rowTaps} added=${lastAdded} header=${headerTaps} footer=${footerTaps}`}
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
          onPress={() =>
            list.current?.scrollToOffset({
              offset: offsetUnderHeader(ITEMS.findIndex((item) => item.key === "Row 5")),
              animated: false,
            })
          }
          accessibilityRole="button"
          accessibilityLabel="Put row 5 under header"
        >
          <Text style={styles.smallButtonText}>Row 5 under header</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() =>
            list.current?.scrollToOffset({ offset: offsetUnderHeader(NOTE_INDEX), animated: false })
          }
          accessibilityRole="button"
          accessibilityLabel="Put note under header"
        >
          <Text style={styles.smallButtonText}>Note under header</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() =>
            // The note's top 70 points above the list's bottom: its 60 points
            // lie inside the 80-point footer.
            list.current?.scrollToOffset({
              offset: offsetUnderHeader(NOTE_INDEX) - (listHeight.current - FOOTER_HEIGHT + 10),
              animated: false,
            })
          }
          accessibilityRole="button"
          accessibilityLabel="Put note under footer"
        >
          <Text style={styles.smallButtonText}>Note under footer</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => {
            dialogOpacity.setValue(1)
            setDialog(true)
          }}
          accessibilityRole="button"
          accessibilityLabel="Show dialog"
        >
          <Text style={styles.smallButtonText}>Show dialog</Text>
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
          onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 20)}
          scrollEventThrottle={16}
          onLayout={(e) => {
            listHeight.current = e.nativeEvent.layout.height
          }}
          data={ITEMS}
          testID="covers-list"
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) =>
            item.note ? (
              <View style={styles.row}>
                <TextInput
                  style={styles.noteInput}
                  value={note}
                  onChangeText={setNote}
                  placeholder="Write a note"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Note"
                  testID="covers-note"
                />
              </View>
            ) : (
              <View style={styles.row}>
                <TouchableOpacity
                  style={styles.rowMain}
                  onPress={() => {
                    setLastRow(item.key)
                    setRowTaps((n) => n + 1)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={item.key}
                  testID="covers-row"
                >
                  <Text style={styles.rowText}>{item.key}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.addButton}
                  onPress={() => setLastAdded(item.key)}
                  accessibilityRole="button"
                  accessibilityLabel="Add"
                >
                  <Text style={styles.rowText}>Add</Text>
                </TouchableOpacity>
              </View>
            )
          }
        />
        <TouchableOpacity
          style={styles.header}
          onPress={() => setHeaderTaps((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Header action"
        >
          <Text style={styles.headerText}>Header action</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.footer}
          onPress={() => setFooterTaps((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Footer action"
        >
          <Text style={styles.buttonText}>Footer action</Text>
        </TouchableOpacity>
      </View>

      {scrolled && (
        <Text style={styles.scrolled} testID="covers-scrolled">
          Scrolled
        </Text>
      )}

      {dialog && (
        <Animated.View style={[fill, { opacity: dialogOpacity }]} testID="covers-dialog">
          <View
            style={[fill, styles.dialogBackdrop]}
            onStartShouldSetResponder={() => true}
            onResponderRelease={closeDialog}
          />
          <View style={styles.dialogCard}>
            <Text style={styles.rowText}>A dialog</Text>
            <TouchableOpacity
              style={styles.smallButton}
              onPress={closeDialog}
              accessibilityRole="button"
              accessibilityLabel="Dialog OK"
            >
              <Text style={styles.smallButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
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
    paddingTop: HEADER_HEIGHT,
    paddingBottom: FOOTER_HEIGHT,
  },
  header: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: HEADER_HEIGHT,
    backgroundColor: "rgba(51, 51, 51, 0.9)",
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
    flexDirection: "row",
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#ddd",
  },
  rowMain: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  addButton: {
    width: 80,
    justifyContent: "center",
    alignItems: "center",
  },
  scrolled: {
    position: "absolute",
    top: 0,
    right: 16,
    fontSize: 11,
    color: "#666",
  },
  dialogBackdrop: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
  },
  dialogCard: {
    position: "absolute",
    top: "30%",
    left: 40,
    right: 40,
    padding: 24,
    gap: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    alignItems: "center",
  },
  noteInput: {
    flex: 1,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  rowText: {
    fontSize: 16,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: FOOTER_HEIGHT,
    backgroundColor: "#34C759",
    alignItems: "center",
    justifyContent: "center",
  },
})
