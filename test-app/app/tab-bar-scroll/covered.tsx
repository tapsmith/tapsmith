import { StyleSheet, Text, View } from "react-native"

import { ROW_HEIGHT, TabBarScrollList } from "../../components/tab-bar-scroll-list"

const BAR_HEIGHT = 64

/** A bar laid over the bottom of the list, as a checkout or player bar is; the row sits under it. */
export default function CoveredTab() {
  return (
    <TabBarScrollList
      targetLabel="Row under the bar"
      targetTop={(h) => h - BAR_HEIGHT + (BAR_HEIGHT - ROW_HEIGHT) / 2}
      overlay={
        <View style={styles.bar} testID="tab-bar-scroll-bar" collapsable={false}>
          <Text style={styles.barText}>Checkout bar</Text>
        </View>
      }
    />
  )
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: BAR_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: 16,
    backgroundColor: "#222",
  },
  barText: { color: "#fff", fontSize: 16 },
})
