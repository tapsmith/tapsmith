import { useRef, useState, type ReactNode } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

export const ROW_HEIGHT = 48

/**
 * A list with one target row placed relative to the list's own height, so it
 * lands outside the part that shows on any screen size. `targetTop(h)` gives
 * the row's offset in the content for a list `h` tall; `initialOffset(h)` the
 * offset the list starts scrolled to. The status line above the list counts
 * the row's taps, and shows them only once the row is laid out and the list
 * is at its starting offset, so a test that waits for it acts on the screen
 * as it will stay.
 */
type TabBarScrollListProps = {
  targetLabel: string
  targetTop: (listHeight: number) => number
  initialOffset?: (listHeight: number) => number
  overlay?: ReactNode
}

export function TabBarScrollList(props: TabBarScrollListProps) {
  // A warm reset navigates here rather than remounting: remount on each one,
  // so the tap count, the ready flag and the list's offset start afresh.
  const resetEpoch = useTapsmithResetEpoch()
  return <List key={resetEpoch} {...props} />
}

function List(props: TabBarScrollListProps) {
  const [listHeight, setListHeight] = useState(0)
  const [taps, setTaps] = useState(0)
  const [ready, setReady] = useState(false)
  const scrolled = useRef(false)
  const list = useRef<ScrollView>(null)
  const top = listHeight > 0 ? props.targetTop(listHeight) : 0

  return (
    <View style={styles.screen}>
      <Text style={styles.status} testID="tab-bar-scroll-status">
        {ready ? `${props.targetLabel} taps: ${taps}` : "Loading"}
      </Text>
      <ScrollView
        ref={list}
        style={styles.list}
        testID="tab-bar-scroll-list"
        onLayout={(e) => setListHeight(Math.round(e.nativeEvent.layout.height))}
        onContentSizeChange={() => {
          if (scrolled.current || listHeight === 0) return
          scrolled.current = true
          if (props.initialOffset) {
            list.current?.scrollTo({ y: props.initialOffset(listHeight), animated: false })
          }
          // A frame later, once the offset has been applied.
          requestAnimationFrame(() => setReady(true))
        }}
      >
        {listHeight > 0 && (
          <View style={{ height: top + ROW_HEIGHT + listHeight * 2 }}>
            <Text style={styles.filler}>Rows above the target</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={props.targetLabel}
              testID="tab-bar-scroll-target"
              onPress={() => setTaps((n) => n + 1)}
              style={[styles.target, { top }]}
            >
              <Text style={styles.targetText}>{props.targetLabel}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
      {props.overlay}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f5f5f5" },
  status: { padding: 12, fontSize: 16, backgroundColor: "#fff" },
  list: { flex: 1 },
  filler: { padding: 16, color: "#666" },
  target: {
    position: "absolute",
    left: 16,
    right: 16,
    height: ROW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: 12,
    backgroundColor: "#4a90d9",
    borderRadius: 6,
  },
  targetText: { color: "#fff", fontSize: 16 },
})
