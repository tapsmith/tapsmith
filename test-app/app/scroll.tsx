import { useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"

const SECTIONS = [
  {
    title: "Section A",
    items: Array.from({ length: 10 }, (_, i) => `A-${i + 1}`),
  },
  {
    title: "Section B",
    items: Array.from({ length: 10 }, (_, i) => `B-${i + 1}`),
  },
  {
    title: "Section C",
    items: Array.from({ length: 10 }, (_, i) => `C-${i + 1}`),
  },
  {
    title: "Section D",
    items: Array.from({ length: 10 }, (_, i) => `D-${i + 1}`),
  },
]

export default function ScrollScreen() {
  const [bottomPresses, setBottomPresses] = useState(0)
  return (
    <ScrollView style={styles.container} testID="main-scroll">
      <Text style={styles.heading} accessibilityRole="header">
        Scroll Testing
      </Text>

      <Text style={styles.description}>
        Long scrollable content with sections. Use for testing scroll actions, toBeInViewport
        assertions, and scroll-until-visible patterns.
      </Text>

      {SECTIONS.map((section) => (
        <View key={section.title}>
          <Text
            style={styles.sectionHeader}
            accessibilityRole="header"
            testID={`section-${section.title}`}
          >
            {section.title}
          </Text>
          {section.items.map((item) => (
            <View
              key={item}
              style={styles.item}
              accessible
              accessibilityLabel={`Item ${item}`}
              testID={`scroll-item-${item}`}
            >
              <Text style={styles.itemText}>Item {item}</Text>
              <Text style={styles.itemSubtext}>Description for item {item}</Text>
            </View>
          ))}
        </View>
      ))}

      {/* The last control in the content: scrolling it into view takes the
          list to its end (PILOT-1444). */}
      <Pressable
        style={styles.bottomButton}
        onPress={() => setBottomPresses((n) => n + 1)}
        accessibilityRole="button"
        testID="scroll-bottom-button"
      >
        <Text style={styles.bottomButtonText}>Bottom button</Text>
      </Pressable>
      <Text style={styles.bottomPresses} testID="scroll-bottom-presses">
        Bottom button presses: {bottomPresses}
      </Text>

      <View style={styles.footer} testID="scroll-footer">
        <Text style={styles.footerText}>End of list</Text>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    padding: 16,
    paddingBottom: 4,
    color: "#1a1a1a",
  },
  description: {
    fontSize: 14,
    color: "#666",
    paddingHorizontal: 16,
    paddingBottom: 8,
    lineHeight: 20,
  },
  sectionHeader: {
    fontSize: 18,
    fontWeight: "bold",
    backgroundColor: "#e8e8e8",
    padding: 12,
    paddingHorizontal: 16,
    color: "#1a1a1a",
    marginTop: 8,
  },
  item: {
    backgroundColor: "#fff",
    padding: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  itemText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  itemSubtext: {
    fontSize: 13,
    color: "#888",
    marginTop: 2,
  },
  bottomButton: {
    margin: 16,
    marginBottom: 4,
    padding: 14,
    borderRadius: 8,
    alignItems: "center",
    backgroundColor: "#1a73e8",
  },
  bottomButtonText: {
    fontSize: 16,
    color: "#fff",
    fontWeight: "600",
  },
  bottomPresses: {
    fontSize: 14,
    color: "#666",
    paddingHorizontal: 16,
  },
  footer: {
    padding: 24,
    alignItems: "center",
  },
  footerText: {
    fontSize: 16,
    color: "#999",
    fontWeight: "600",
  },
})
