import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native"

/**
 * A carousel that turns a page while a touch is held.
 *
 * React Native gives a touch to the scroll view around it when a scroll event
 * comes while the touch is down, even one from a nested scroll view such as a
 * carousel paging itself, and the press is cancelled. A self-paging carousel
 * turns at a random moment, so a touch held for long enough loses it now and
 * then (3 in 40 with a 100 ms hold). Here the carousel turns a page 50 ms
 * after a touch lands on any control below it, every time, so on iOS a touch
 * held past that is cancelled every time and a short one never is. React
 * Native on Android keeps the press whatever the hold.
 *
 * One control for each action that touches: a button (tap), a double-tap
 * target, a switch (setChecked) and a dropdown whose options are a list of
 * texts (selectOption). The double-tap target turns the carousel on its second
 * touch only, so each tap's own hold is what is tested: a tap that lands while
 * the carousel is still turning is a different case, lost on iOS at any hold
 * but none.
 *
 * Below them, a button that slides across its track when "Slide the button
 * in" is pressed, so a tap that comes straight after finds it mid-slide: the
 * tap has to wait for it to stop, not land where the find saw it.
 */
const PAGES = ["Summer sale", "New arrivals", "Free delivery"]
const TURN_AFTER_MS = 50
// The double-tap target turns sooner: a double tap's presses used to be held
// 40 ms each, which a 50 ms turn would not catch.
const DOUBLE_TAP_TURN_AFTER_MS = 15
const SIZES = ["Small", "Medium", "Large"]
// Measured between JS onPress callbacks, as on the gestures screen.
const DOUBLE_TAP_WINDOW_MS = 800
// Fast enough that the button moves further than half its width between a
// find and a tap made from it, slow enough that the find sees it moving.
const SLIDE_MS = 400
const SLIDER_WIDTH_SHARE = 0.3

/** A touch anywhere inside calls `onTouch` as it lands. */
function Turns({ onTouch, children }: { onTouch: () => void; children: ReactNode }) {
  return <View onTouchStart={() => onTouch()}>{children}</View>
}

export default function CarouselScreen() {
  const carousel = useRef<ScrollView>(null)
  const page = useRef(0)
  const [added, setAdded] = useState(0)
  const [likes, setLikes] = useState(0)
  const [giftWrap, setGiftWrap] = useState(false)
  const [sizesOpen, setSizesOpen] = useState(false)
  const [size, setSize] = useState("None")
  const pendingTap = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { width } = useWindowDimensions()
  const pageWidth = width - 32
  const [caught, setCaught] = useState(0)
  const slide = useRef(new Animated.Value(0)).current
  const slideTravel = pageWidth * (1 - SLIDER_WIDTH_SHARE)

  const slideIn = () => {
    // From the far end of the track to the near one, at an even speed.
    slide.setValue(slideTravel)
    Animated.timing(slide, {
      toValue: 0,
      duration: SLIDE_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start()
  }

  useEffect(
    () => () => {
      if (pendingTap.current) clearTimeout(pendingTap.current)
    },
    [],
  )

  const likeTouches = useRef(0)

  const turnPageSoon = (afterMs = TURN_AFTER_MS) => {
    setTimeout(() => {
      page.current = (page.current + 1) % PAGES.length
      // No animation: the jump's scroll event is what cancels a held
      // touch, and no turn is still running when the next touch lands.
      carousel.current?.scrollTo({ x: page.current * pageWidth, animated: false })
    }, afterMs)
  }

  const likeTapped = () => {
    if (pendingTap.current) {
      clearTimeout(pendingTap.current)
      pendingTap.current = null
      setLikes((n) => n + 1)
      return
    }
    pendingTap.current = setTimeout(() => {
      pendingTap.current = null
    }, DOUBLE_TAP_WINDOW_MS)
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

      <Turns onTouch={turnPageSoon}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setAdded((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Add to basket"
          testID="carousel-add"
        >
          <Text style={styles.buttonText}>Add to basket</Text>
        </TouchableOpacity>
      </Turns>
      <Text style={styles.status} testID="carousel-added">
        In basket: {added}
      </Text>

      <Turns
        onTouch={() => {
          likeTouches.current += 1
          if (likeTouches.current % 2 === 0) turnPageSoon(DOUBLE_TAP_TURN_AFTER_MS)
        }}
      >
        <TouchableOpacity
          style={styles.button}
          onPress={likeTapped}
          accessibilityRole="button"
          accessibilityLabel="Double-tap to like"
          testID="carousel-like"
        >
          <Text style={styles.buttonText}>Double-tap to like</Text>
        </TouchableOpacity>
      </Turns>
      <Text style={styles.status} testID="carousel-likes">
        Likes: {likes}
      </Text>

      <View style={styles.row}>
        <Text style={styles.label}>Gift wrap</Text>
        <Turns onTouch={turnPageSoon}>
          <Switch
            value={giftWrap}
            onValueChange={setGiftWrap}
            accessibilityLabel="Gift wrap"
            testID="carousel-gift-wrap"
          />
        </Turns>
      </View>
      <Text style={styles.status} testID="carousel-gift-wrap-state">
        Gift wrap: {giftWrap ? "on" : "off"}
      </Text>

      <Turns onTouch={turnPageSoon}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => setSizesOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel="Choose a size"
          testID="carousel-size"
        >
          <Text style={styles.buttonText}>Choose a size</Text>
        </TouchableOpacity>
      </Turns>
      {sizesOpen &&
        SIZES.map((name) => (
          <Turns key={name} onTouch={turnPageSoon}>
            <TouchableOpacity
              style={styles.option}
              // Not one accessible element: the option is found by its text,
              // as a dropdown's options are.
              accessible={false}
              onPress={() => {
                setSize(name)
                setSizesOpen(false)
              }}
            >
              <Text style={styles.optionText}>{name}</Text>
            </TouchableOpacity>
          </Turns>
        ))}
      <Text style={styles.status} testID="carousel-size-chosen">
        Size: {size}
      </Text>

      <TouchableOpacity
        style={styles.button}
        onPress={slideIn}
        accessibilityRole="button"
        accessibilityLabel="Slide the button in"
        testID="carousel-slide"
      >
        <Text style={styles.buttonText}>Slide the button in</Text>
      </TouchableOpacity>
      <View style={styles.track}>
        <Animated.View
          style={{ width: pageWidth * SLIDER_WIDTH_SHARE, transform: [{ translateX: slide }] }}
        >
          <TouchableOpacity
            style={[styles.button, styles.slider]}
            onPress={() => setCaught((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Catch me"
            testID="carousel-catch"
          >
            <Text style={styles.buttonText}>Catch me</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
      <Text style={styles.status} testID="carousel-caught">
        Caught: {caught}
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
    height: 120,
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
    paddingVertical: 12,
    marginTop: 16,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
  },
  label: {
    fontSize: 16,
    color: "#333",
  },
  track: {
    marginTop: 8,
  },
  slider: {
    marginTop: 0,
  },
  option: {
    backgroundColor: "#fff",
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  optionText: {
    fontSize: 16,
    color: "#333",
  },
  status: {
    fontSize: 16,
    color: "#333",
    marginTop: 8,
  },
})
