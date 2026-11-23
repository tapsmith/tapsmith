import { StyleSheet, Text, View } from "react-native"

export default function MoreTab() {
  return (
    <View style={styles.container}>
      <Text testID="header-menu-content">More content</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
})
