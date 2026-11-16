import { useRouter } from "expo-router"
import { useEffect } from "react"
import { StyleSheet, Text, TouchableOpacity, View } from "react-native"
import { useAuth } from "./auth-context"

export default function ProfileScreen() {
  const { email, loading, logout, reloadCount } = useAuth()
  const router = useRouter()

  // Gate: redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !email) {
      router.replace("/login")
    }
  }, [loading, email, router])

  if (loading || !email) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText} accessibilityRole="text">
          Loading...
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        Profile
      </Text>
      <View style={styles.card}>
        <Text style={styles.label}>Email</Text>
        <Text style={styles.value} testID="profile-email">
          {email}
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Account status</Text>
        <Text style={styles.value} testID="profile-status">
          Authenticated
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Reloads kept from storage</Text>
        <Text style={styles.value} testID="profile-reload-count">
          {String(reloadCount)}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.logoutButton}
        onPress={async () => {
          await logout()
          router.replace("/login")
        }}
        accessibilityRole="button"
        accessibilityLabel="Log out"
      >
        <Text style={styles.logoutText}>Log out</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
    padding: 24,
  },
  heading: {
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 24,
    color: "#1a1a1a",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  label: {
    fontSize: 14,
    color: "#666",
    marginBottom: 4,
  },
  value: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1a1a1a",
  },
  logoutButton: {
    backgroundColor: "#FF3B30",
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    marginTop: 16,
  },
  logoutText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
  loadingText: {
    fontSize: 18,
    color: "#666",
    textAlign: "center",
    marginTop: 60,
  },
})
