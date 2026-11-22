import { useRef, useState, type ReactNode } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"

export const ROW_HEIGHT = 48

/**
 * A list with one target row placed relative to the list's own height, so it
 * lands outside the part that shows on any screen size. `targetTop(h)` gives
 * the row's offset in the content for a list `h` tall; `initialOffset(h)` the
 * offset the list starts scrolled to. The status line above the list counts
 * the row's taps.
 */
export function TabBarScrollList(props: {
  targetLabel: string
  targetTop: (listHeight: number) => number
  initialOffset?: (listHeight: number) => number
  overlay?: ReactNode
}) {
  const [listHeight, setListHeight] = useState(0)
  const [taps, setTaps] = useState(0)
  const scrolled = useRef(false)
  const list = useRef<ScrollView>(null)
  const top = listHeight > 0 ? props.targetTop(listHeight) : 0

  return (
    <View style={styles.screen}>
      <Text style={styles.status} testID="tab-bar-scroll-status">
        {`${props.targetLabel} taps: ${taps}`}
      </Text>
      <ScrollView
        ref={list}
        style={styles.list}
        testID="tab-bar-scroll-list"
        onLayout={(e) => setListHeight(Math.round(e.nativeEvent.layout.height))}
        onContentSizeChange={() => {
          if (scrolled.current || listHeight === 0 || !props.initialOffset) return
          scrolled.current = true
          list.current?.scrollTo({ y: props.initialOffset(listHeight), animated: false })
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
