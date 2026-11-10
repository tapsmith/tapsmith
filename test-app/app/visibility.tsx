import { useEffect, useRef, useState } from "react"
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"

export default function VisibilityScreen() {
  const [bannerVisible, setBannerVisible] = useState(true)
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const [items, setItems] = useState(["Item A", "Item B", "Item C"])
  const [loading, setLoading] = useState(false)
  const [errorVisible, setErrorVisible] = useState(false)
  // Each start replaces the pending stop, so a timer from an earlier start
  // can't end a later one early (PILOT-1127).
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(loadingTimer.current), [])

  const handleDelete = (item: string) => {
    setItems((prev) => prev.filter((i) => i !== item))
  }

  const handleAddItem = () => {
    setItems((prev) => [...prev, `Item ${String.fromCharCode(65 + prev.length)}`])
  }

  const handleToggleLoading = () => {
    setLoading(true)
    clearTimeout(loadingTimer.current)
    loadingTimer.current = setTimeout(() => setLoading(false), 2000)
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Visibility Testing
      </Text>

      {/* Dismissable banner */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Dismissable Banner
      </Text>
      {bannerVisible ? (
        <View style={styles.banner} testID="banner">
          <Text style={styles.bannerText}>Welcome! This is a dismissable banner.</Text>
          <TouchableOpacity
            onPress={() => setBannerVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss banner"
            testID="dismiss-banner"
          >
            <Text style={styles.bannerClose}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.showButton}
          onPress={() => setBannerVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Show banner"
          testID="show-banner"
        >
          <Text style={styles.showButtonText}>Show banner</Text>
        </TouchableOpacity>
      )}

      {/* Expandable section */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Expandable Section
      </Text>
      <TouchableOpacity
        style={styles.expandHeader}
        onPress={() => setDetailsExpanded(!detailsExpanded)}
        accessibilityRole="button"
        accessibilityLabel="Toggle details"
        accessibilityState={{ expanded: detailsExpanded }}
        testID="expand-toggle"
      >
        <Text style={styles.expandHeaderText}>Details</Text>
        <Text style={styles.expandArrow}>{detailsExpanded ? "▲" : "▼"}</Text>
      </TouchableOpacity>
      {detailsExpanded && (
        <View style={styles.expandContent} testID="expanded-content">
          <Text style={styles.expandText}>
            This content is hidden by default and shown when expanded. It contains additional
            details that are not always needed.
          </Text>
          <Text style={styles.expandText}>Second paragraph with more information.</Text>
        </View>
      )}

      {/* Dynamic list */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Dynamic List
      </Text>
      {items.map((item) => (
        <View key={item} style={styles.listItem} testID={`dynamic-item-${item}`}>
          <Text style={styles.listItemText}>{item}</Text>
          <TouchableOpacity
            onPress={() => handleDelete(item)}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${item}`}
          >
            <Text style={styles.deleteButton}>Delete</Text>
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity
        style={styles.addButton}
        onPress={handleAddItem}
        accessibilityRole="button"
        accessibilityLabel="Add item"
        testID="add-item"
      >
        <Text style={styles.addButtonText}>+ Add Item</Text>
      </TouchableOpacity>

      <Text style={styles.countText} testID="dynamic-list-count">
        {items.length} items
      </Text>

      {/* Loading state */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Loading State
      </Text>
      <TouchableOpacity
        style={styles.button}
        onPress={handleToggleLoading}
        accessibilityRole="button"
        accessibilityLabel="Start loading"
        testID="start-loading"
      >
        <Text style={styles.buttonText}>Start Loading</Text>
      </TouchableOpacity>
      {loading ? (
        <Text style={styles.loadingText} testID="loading-indicator">
          Loading...
        </Text>
      ) : (
        <Text style={styles.loadedText} testID="content-loaded">
          Content loaded
        </Text>
      )}

      {/* Error state */}
      <Text style={styles.sectionHeader} accessibilityRole="header">
        Error State
      </Text>
      <TouchableOpacity
        style={[styles.button, styles.buttonDanger]}
        onPress={() => setErrorVisible(!errorVisible)}
        accessibilityRole="button"
        accessibilityLabel="Toggle error"
        testID="toggle-error"
      >
        <Text style={styles.buttonText}>{errorVisible ? "Clear Error" : "Trigger Error"}</Text>
      </TouchableOpacity>
      {errorVisible && (
        <Text style={styles.errorText} accessibilityRole="alert" testID="error-message">
          An error occurred. Please try again.
        </Text>
      )}

      <View style={styles.spacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 16,
    color: "#1a1a1a",
  },
  sectionHeader: {
    fontSize: 18,
    fontWeight: "bold",
    marginTop: 20,
    marginBottom: 8,
    color: "#1a1a1a",
  },
  banner: {
    backgroundColor: "#E8F4FD",
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#007AFF",
  },
  bannerText: {
    fontSize: 14,
    color: "#007AFF",
    flex: 1,
  },
  bannerClose: {
    fontSize: 18,
    color: "#007AFF",
    paddingLeft: 12,
  },
  showButton: {
    padding: 12,
    alignItems: "center",
  },
  showButtonText: {
    color: "#007AFF",
    fontSize: 16,
  },
  expandHeader: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  expandHeaderText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  expandArrow: {
    fontSize: 12,
    color: "#666",
  },
  expandContent: {
    backgroundColor: "#fff",
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: "#f0f0f0",
  },
  expandText: {
    fontSize: 14,
    color: "#666",
    marginBottom: 8,
    lineHeight: 20,
  },
  listItem: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 14,
    marginBottom: 6,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  listItemText: {
    fontSize: 16,
    color: "#1a1a1a",
  },
  deleteButton: {
    color: "#FF3B30",
    fontSize: 14,
    fontWeight: "600",
  },
  addButton: {
    padding: 12,
    alignItems: "center",
  },
  addButtonText: {
    color: "#007AFF",
    fontSize: 16,
    fontWeight: "600",
  },
  countText: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginBottom: 8,
  },
  buttonDanger: {
    backgroundColor: "#FF3B30",
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingText: {
    fontSize: 16,
    color: "#FF9500",
    textAlign: "center",
    padding: 12,
  },
  loadedText: {
    fontSize: 16,
    color: "#34C759",
    textAlign: "center",
    padding: 12,
  },
  errorText: {
    backgroundColor: "#FFF0F0",
    color: "#FF3B30",
    fontSize: 14,
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  spacer: {
    height: 32,
  },
})
