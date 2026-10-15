import { StyleSheet, Text, View } from "react-native"

export default function HomeTab() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Home content</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 18 },
})
