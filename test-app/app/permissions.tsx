import { useState } from "react"
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native"
import * as Location from "expo-location"
import { Camera } from "expo-camera"

export default function PermissionsScreen() {
  const [cameraStatus, setCameraStatus] = useState("unknown")
  const [locationStatus, setLocationStatus] = useState("unknown")

  const requestCamera = async () => {
    try {
      const { status } = await Camera.requestCameraPermissionsAsync()
      setCameraStatus(status)
    } catch {
      setCameraStatus("error")
    }
  }

  // Reads the camera permission without prompting.
  const checkCamera = async () => {
    try {
      const { status } = await Camera.getCameraPermissionsAsync()
      setCameraStatus(status)
    } catch {
      setCameraStatus("error")
    }
  }

  const requestLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync()
      setLocationStatus(status)
    } catch {
      setLocationStatus("error")
    }
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Permissions
      </Text>

      <Text style={styles.description}>Test granting and revoking runtime permissions.</Text>

      <View
        style={styles.permissionCard}
        accessible
        accessibilityLabel={`Camera permission: ${cameraStatus}`}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionName}>Camera</Text>
          <Text
            style={[
              styles.permissionStatus,
              cameraStatus === "granted" && styles.statusGranted,
              cameraStatus === "denied" && styles.statusDenied,
            ]}
            testID="camera-status"
          >
            {cameraStatus}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.button}
          onPress={requestCamera}
          accessibilityRole="button"
          accessibilityLabel="Request camera permission"
          testID="request-camera"
        >
          <Text style={styles.buttonText}>Request</Text>
        </TouchableOpacity>
      </View>

      {/* Outside the card: an accessible card hides its children on iOS. */}
      <TouchableOpacity
        style={[styles.button, styles.checkButton]}
        onPress={checkCamera}
        accessibilityRole="button"
        accessibilityLabel="Check camera permission"
        testID="check-camera"
      >
        <Text style={styles.buttonText}>Check camera permission</Text>
      </TouchableOpacity>

      <View
        style={styles.permissionCard}
        accessible
        accessibilityLabel={`Location permission: ${locationStatus}`}
      >
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionName}>Location</Text>
          <Text
            style={[
              styles.permissionStatus,
              locationStatus === "granted" && styles.statusGranted,
              locationStatus === "denied" && styles.statusDenied,
            ]}
            testID="location-status"
          >
            {locationStatus}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.button}
          onPress={requestLocation}
          accessibilityRole="button"
          accessibilityLabel="Request location permission"
          testID="request-location"
        >
          <Text style={styles.buttonText}>Request</Text>
        </TouchableOpacity>
      </View>

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
    marginBottom: 8,
    color: "#1a1a1a",
  },
  description: {
    fontSize: 14,
    color: "#666",
    marginBottom: 16,
  },
  permissionCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  permissionInfo: {
    flex: 1,
  },
  permissionName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  permissionStatus: {
    fontSize: 14,
    color: "#999",
    marginTop: 4,
  },
  checkButton: {
    alignItems: "center",
    marginBottom: 12,
  },
  statusGranted: {
    color: "#34C759",
  },
  statusDenied: {
    color: "#FF3B30",
  },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  spacer: {
    height: 32,
  },
})
