import { useLocalSearchParams, useRouter } from "expo-router"
import { Pressable, StyleSheet, Text, View } from "react-native"

/**
 * A screen that pushes more of itself, so that every level of a native stack
 * has the same controls, as a custom header's back button does (PILOT-985).
 */
export default function StackLevelScreen() {
  const { level } = useLocalSearchParams<{ level: string }>()
  const router = useRouter()
  const n = Number(level)

  return (
    <View style={styles.container}>
      <Pressable
        testID="stack-back"
        accessibilityRole="button"
        accessibilityLabel="Back one level"
        style={styles.button}
        onPress={() => router.back()}
      >
        <Text style={styles.buttonText}>Back one level</Text>
      </Pressable>
      <Text testID="stack-level" style={styles.level}>{`Level ${n}`}</Text>
      <Pressable
        testID="stack-push"
        accessibilityRole="button"
        accessibilityLabel="Push a level"
        style={styles.button}
        onPress={() => router.push(`/stack/${n + 1}`)}
      >
        <Text style={styles.buttonText}>Push a level</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 24, backgroundColor: "#fff" },
  button: { padding: 16, borderRadius: 8, backgroundColor: "#2563eb", alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "600" },
  level: { fontSize: 24, textAlign: "center" },
})
