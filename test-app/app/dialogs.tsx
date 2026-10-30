import { useState } from "react"
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"

export default function DialogsScreen() {
  const [toastVisible, setToastVisible] = useState(false)
  const [toastMessage, setToastMessage] = useState("")
  const [snackbarVisible, setSnackbarVisible] = useState(false)
  const [snackbarMessage, setSnackbarMessage] = useState("")
  const [modalVisible, setModalVisible] = useState(false)
  const [sheetVisible, setSheetVisible] = useState(false)
  const [confirmResult, setConfirmResult] = useState("")

  const showToast = (message: string) => {
    setToastMessage(message)
    setToastVisible(true)
    // Long enough to survive the E2E assertion cadence on loaded CI
    // simulators: tests assert on the toast after first asserting the modal
    // dismissed, and each step can take seconds on iOS. A 3s toast expired
    // before it was ever observed.
    setTimeout(() => setToastVisible(false), 10000)
  }

  const showSnackbar = (message: string) => {
    setSnackbarMessage(message)
    setSnackbarVisible(true)
    setTimeout(() => setSnackbarVisible(false), 4000)
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading} accessibilityRole="header">
          Dialogs & Overlays
        </Text>

        <Text style={styles.sectionHeader} accessibilityRole="header">
          Alerts
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => Alert.alert("Info", "This is an informational alert.")}
          accessibilityRole="button"
          accessibilityLabel="Show alert"
          testID="show-alert-button"
        >
          <Text style={styles.buttonText}>Show Alert</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          onPress={() =>
            Alert.alert("Confirm", "Are you sure?", [
              { text: "Cancel", onPress: () => setConfirmResult("Cancelled") },
              { text: "OK", onPress: () => setConfirmResult("Confirmed") },
            ])
          }
          accessibilityRole="button"
          accessibilityLabel="Show confirm dialog"
          testID="show-confirm-button"
        >
          <Text style={styles.buttonText}>Show Confirm</Text>
        </TouchableOpacity>

        <Text style={styles.resultText} testID="confirm-result">
          Result: {confirmResult || "None"}
        </Text>

        <Text style={styles.sectionHeader} accessibilityRole="header">
          Toast
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => showToast("Item saved successfully!")}
          accessibilityRole="button"
          accessibilityLabel="Show toast"
          testID="show-toast-button"
        >
          <Text style={styles.buttonText}>Show Toast</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonDanger]}
          onPress={() => showToast("Something went wrong")}
          accessibilityRole="button"
          accessibilityLabel="Show error toast"
          testID="show-error-toast-button"
        >
          <Text style={styles.buttonText}>Show Error Toast</Text>
        </TouchableOpacity>

        <Text style={styles.sectionHeader} accessibilityRole="header">
          Snackbar
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => showSnackbar("Message archived")}
          accessibilityRole="button"
          accessibilityLabel="Show snackbar"
          testID="show-snackbar-button"
        >
          <Text style={styles.buttonText}>Show Snackbar</Text>
        </TouchableOpacity>

        <Text style={styles.sectionHeader} accessibilityRole="header">
          Modal
        </Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => setModalVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Show modal"
          testID="show-modal-button"
        >
          <Text style={styles.buttonText}>Show Modal</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.button}
          onPress={() => setSheetVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Show sheet"
          testID="show-sheet-button"
        >
          <Text style={styles.buttonText}>Show Sheet</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Toast overlay */}
      {toastVisible && (
        <View style={styles.toast} accessibilityRole="alert" testID="toast">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      )}

      {/* Snackbar overlay */}
      {snackbarVisible && (
        <View style={styles.snackbar} accessibilityRole="alert" testID="snackbar">
          <Text style={styles.snackbarText}>{snackbarMessage}</Text>
          <TouchableOpacity
            onPress={() => setSnackbarVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.snackbarAction}>DISMISS</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent} accessibilityRole="alert" testID="modal">
            <Text style={styles.modalTitle}>Modal Title</Text>
            <Text style={styles.modalBody}>
              This is a modal dialog. It overlays the screen and requires interaction to dismiss.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={() => setModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.modalButtonTextCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={() => {
                  setModalVisible(false)
                  showToast("Action confirmed!")
                }}
                accessibilityRole="button"
                accessibilityLabel="Confirm"
              >
                <Text style={styles.modalButtonText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* A scrolling sheet over a backdrop that closes it, like a dialog or
          bottom sheet whose content scrolls: a swipe that starts outside the
          sheet taps the backdrop and closes it (PILOT-934). */}
      <Modal
        visible={sheetVisible}
        transparent
        animationType="none"
        onRequestClose={() => setSheetVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setSheetVisible(false)}
            accessibilityRole="button"
            accessibilityLabel="Close sheet"
          />
          <View style={styles.sheet} testID="sheet">
            <Text style={styles.modalTitle}>Sheet Title</Text>
            <ScrollView testID="sheet-scroll">
              {Array.from({ length: 30 }, (_, i) => (
                <Text key={i} style={styles.sheetItem}>{`Sheet item ${i + 1}`}</Text>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
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
  resultText: {
    fontSize: 14,
    color: "#666",
    marginTop: 4,
    marginBottom: 8,
  },
  toast: {
    position: "absolute",
    top: 60,
    left: 24,
    right: 24,
    backgroundColor: "#333",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  toastText: {
    color: "#fff",
    fontSize: 16,
  },
  snackbar: {
    position: "absolute",
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: "#333",
    borderRadius: 8,
    padding: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  snackbarText: {
    color: "#fff",
    fontSize: 16,
    flex: 1,
  },
  snackbarAction: {
    color: "#4FC3F7",
    fontSize: 14,
    fontWeight: "bold",
    marginLeft: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    width: "85%",
    maxWidth: 400,
  },
  sheet: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 24,
    width: "85%",
    maxWidth: 400,
    height: "40%",
  },
  sheetItem: {
    fontSize: 16,
    paddingVertical: 12,
    color: "#1a1a1a",
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 12,
    color: "#1a1a1a",
  },
  modalBody: {
    fontSize: 16,
    color: "#666",
    marginBottom: 24,
    lineHeight: 22,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12,
  },
  modalButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modalButtonPrimary: {
    backgroundColor: "#007AFF",
  },
  modalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  modalButtonTextCancel: {
    color: "#666",
    fontSize: 16,
  },
})
