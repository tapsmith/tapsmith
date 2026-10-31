import { useRef, useState } from "react"
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native"

/**
 * A carousel that turns a page while a tap is held (PILOT-974).
 *
 * React Native gives a touch to the scroll view around it when a scroll event
 * comes while the touch is down, even one from a nested scroll view such as a
 * carousel paging itself, and the press is cancelled. A self-paging carousel
 * turns at a random moment, so a tap held for long enough loses it now and
 * then (3 in 40 with a 100 ms hold). Here the carousel turns a page 50 ms
 * after a touch lands on the button below it, every time, so on iOS a tap
 * held past that is cancelled every time and a short one never is. React
 * Native on Android keeps the press whatever the hold.
 */
const PAGES = ["Summer sale", "New arrivals", "Free delivery"]
const TURN_AFTER_MS = 50

export default function CarouselScreen() {
  const carousel = useRef<ScrollView>(null)
  const page = useRef(0)
  const [added, setAdded] = useState(0)
  const { width } = useWindowDimensions()
  const pageWidth = width - 32

  const turnPageSoon = () => {
    setTimeout(() => {
      page.current = (page.current + 1) % PAGES.length
      carousel.current?.scrollTo({ x: page.current * pageWidth, animated: true })
    }, TURN_AFTER_MS)
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ScrollView
        ref={carousel}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        // Scroll events reach JS only with a handler.
        onScroll={() => {}}
        scrollEventThrottle={16}
        style={{ width: pageWidth }}
      >
        {PAGES.map((title) => (
          <View key={title} style={[styles.page, { width: pageWidth }]}>
            <Text style={styles.pageText}>{title}</Text>
          </View>
        ))}
      </ScrollView>

      <View onTouchStart={turnPageSoon}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setAdded((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Add to basket"
          testID="carousel-add"
        >
          <Text style={styles.buttonText}>Add to basket</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.status} testID="carousel-added">
        In basket: {added}
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  content: {
    padding: 16,
  },
  page: {
    height: 160,
    backgroundColor: "#007AFF",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  pageText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "bold",
  },
  button: {
    backgroundColor: "#34C759",
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 24,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  status: {
    fontSize: 16,
    color: "#333",
    marginTop: 16,
  },
})
