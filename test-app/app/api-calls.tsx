import { useLocalSearchParams } from "expo-router"
import { useEffect, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"

interface Post {
  id: number
  title: string
  body: string
}

interface User {
  id: number
  name: string
  email: string
  phone: string
}

export default function ApiCallsScreen() {
  const [posts, setPosts] = useState<Post[]>([])
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState("")
  const [error, setError] = useState("")

  const fetchPosts = async () => {
    setLoading("posts")
    setError("")
    setPosts([])
    try {
      const res = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=3")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setPosts(data)
    } catch (e) {
      setError(`Failed to fetch posts: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading("")
    }
  }

  // `?autoload=posts` fetches the posts as the screen mounts, so a deep link
  // that cold-launches the app sends the request in its first moments — the
  // launch-time request e2e checks the proxy sees (PILOT-1196).
  const { autoload } = useLocalSearchParams<{ autoload?: string }>()
  useEffect(() => {
    if (autoload === "posts") void fetchPosts()
    // Once per mount: fetchPosts is recreated every render.
  }, [autoload])

  const fetchUser = async () => {
    setLoading("user")
    setError("")
    setUser(null)
    try {
      const res = await fetch("https://jsonplaceholder.typicode.com/users/1")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setUser(data)
    } catch (e) {
      setError(`Failed to fetch user: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading("")
    }
  }

  const fetchNotFound = async () => {
    setLoading("404")
    setError("")
    try {
      const res = await fetch("https://jsonplaceholder.typicode.com/posts/99999")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      setError(`Request failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading("")
    }
  }

  // Exists purely so e2e can assert platform behaviour for a host in the
  // daemon's DEFAULT_PASSTHROUGH_HOSTS list (PILOT-279): captured on Android,
  // tunnelled on iOS. The response is expected to be an unauthenticated
  // error — the test asserts on whether the request was *visible* to
  // interception, never on its status — so no state is stored.
  const fetchFirestoreHost = async () => {
    setLoading("firestore")
    setError("")
    try {
      await fetch(
        "https://firestore.googleapis.com/v1/projects/tapsmith-e2e/databases/(default)/documents",
      )
    } catch (e) {
      setError(`Request failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoading("")
    }
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.heading} accessibilityRole="header">
        API Calls
      </Text>
      <Text style={styles.description}>
        Makes real HTTP requests to jsonplaceholder.typicode.com
      </Text>

      {/* Buttons */}
      <View style={styles.buttonRow}>
        <Pressable
          style={styles.button}
          onPress={fetchPosts}
          accessibilityRole="button"
          accessibilityLabel="Fetch Posts"
        >
          <Text style={styles.buttonText}>Fetch Posts</Text>
        </Pressable>

        <Pressable
          style={styles.button}
          onPress={fetchUser}
          accessibilityRole="button"
          accessibilityLabel="Fetch User"
        >
          <Text style={styles.buttonText}>Fetch User</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.errorButton]}
          onPress={fetchNotFound}
          accessibilityRole="button"
          accessibilityLabel="Fetch 404"
        >
          <Text style={styles.buttonText}>Fetch 404</Text>
        </Pressable>
      </View>

      {/* Second row: kept off the row above so the three original buttons
          keep their existing widths and positional selectors still hold. */}
      <View style={styles.buttonRow}>
        <Pressable
          style={styles.button}
          onPress={fetchFirestoreHost}
          accessibilityRole="button"
          accessibilityLabel="Fetch Firestore Host"
        >
          <Text style={styles.buttonText}>Fetch Firestore Host</Text>
        </Pressable>
      </View>

      {/* Loading */}
      {loading !== "" && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color="#007AFF" />
          <Text style={styles.loadingText}>Loading {loading}...</Text>
        </View>
      )}

      {/* Error */}
      {error !== "" && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText} accessibilityRole="alert">
            {error}
          </Text>
        </View>
      )}

      {/* Posts */}
      {posts.length > 0 && (
        <View>
          <Text style={styles.sectionHeading} accessibilityRole="header">
            Posts
          </Text>
          {posts.map((post) => (
            <View key={post.id} style={styles.card}>
              <Text style={styles.cardTitle}>{post.title}</Text>
              <Text style={styles.cardBody}>{post.body}</Text>
            </View>
          ))}
        </View>
      )}

      {/* User */}
      {user && (
        <View>
          <Text style={styles.sectionHeading} accessibilityRole="header">
            User
          </Text>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{user.name}</Text>
            <Text style={styles.cardBody}>{user.email}</Text>
            <Text style={styles.cardBody}>{user.phone}</Text>
          </View>
        </View>
      )}

      <View style={styles.spacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5", padding: 16 },
  heading: { fontSize: 24, fontWeight: "bold", marginBottom: 4, color: "#1a1a1a" },
  description: { fontSize: 14, color: "#666", marginBottom: 16 },
  buttonRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  button: {
    backgroundColor: "#007AFF",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    flex: 1,
  },
  errorButton: { backgroundColor: "#FF3B30" },
  buttonText: { color: "#fff", fontWeight: "600", textAlign: "center", fontSize: 14 },
  loadingContainer: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  loadingText: { color: "#666", fontSize: 14 },
  errorContainer: {
    backgroundColor: "#FFF0F0",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#FFD0D0",
  },
  errorText: { color: "#CC0000", fontSize: 14 },
  sectionHeading: { fontSize: 18, fontWeight: "600", color: "#1a1a1a", marginBottom: 8 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  cardTitle: { fontSize: 14, fontWeight: "600", color: "#1a1a1a", marginBottom: 4 },
  cardBody: { fontSize: 13, color: "#666", lineHeight: 18 },
  spacer: { height: 32 },
})
