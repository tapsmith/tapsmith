import { useTapsmithResetEpoch } from "@tapsmith/react-native"
import { useEffect, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"

// A task list whose rows put a checkbox, named after the task, beside the
// task's text, the way apps usually build one. The checkbox's label
// ("Toggle Buy oat milk") is its accessible name, not text on screen: on
// both platforms getByLabel finds the checkbox and getByText the row's text
// alone. The switch's label is shown beside it the same way.

const TASKS = ["Buy oat milk", "Walk the dog"]

export default function ChecklistScreen() {
  const [done, setDone] = useState<string[]>([])
  const [remind, setRemind] = useState(false)

  // A warm reset that lands on this screen navigates here rather than
  // remounting, so put the screen back to its initial state.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setDone([])
    setRemind(false)
  }, [resetEpoch])

  const toggle = (task: string) =>
    setDone((current) =>
      current.includes(task) ? current.filter((t) => t !== task) : [...current, task],
    )

  return (
    <ScrollView style={styles.container}>
      {TASKS.map((task) => {
        const checked = done.includes(task)
        return (
          <View key={task} style={styles.row}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={`Toggle ${task}`}
              accessibilityState={{ checked }}
              onPress={() => toggle(task)}
              style={[styles.checkbox, checked && styles.checked]}
            />
            <Text style={styles.title}>{task}</Text>
          </View>
        )
      })}

      <View style={styles.row}>
        <Text style={styles.title}>Remind me</Text>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Remind me"
          accessibilityState={{ checked: remind }}
          onPress={() => setRemind(!remind)}
          style={[styles.track, remind && styles.checked]}
        >
          <View style={[styles.knob, remind && styles.knobOn]} />
        </Pressable>
      </View>

      <Text style={styles.status} testID="checklist-status">
        {`Done: ${done.length} of ${TASKS.length}${remind ? ", reminders on" : ""}`}
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    paddingTop: 16,
  },
  row: {
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
    gap: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: "#ccc",
    borderRadius: 4,
  },
  checked: {
    backgroundColor: "#007AFF",
    borderColor: "#007AFF",
  },
  title: {
    flex: 1,
    fontSize: 16,
    color: "#1a1a1a",
  },
  track: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#ccc",
    padding: 2,
  },
  knob: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#fff",
  },
  knobOn: {
    alignSelf: "flex-end",
  },
  status: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 14,
    color: "#666",
  },
})
