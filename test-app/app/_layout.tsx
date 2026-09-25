import { TapsmithTestHooks } from "@tapsmith/react-native"
import * as Linking from "expo-linking"
import { Stack } from "expo-router"
import { StyleSheet, View } from "react-native"
import { AuthProvider, useAuth } from "./auth-context"

/**
 * Tapsmith's in-app reset hooks. Renders the always-present marker Tapsmith
 * detects (so `appReset: 'auto'` becomes a warm, per-test reset) and handles
 * the reset links it opens: clear app state, then let expo-router land on the
 * requested route. The legacy `/__reset` route stays for the explicit
 * `resetAppDeepLink` configuration exercised by `tapsmith.config.ios-mixed.mjs`.
 *
 * Enabled in dev builds and in release builds made with
 * `EXPO_PUBLIC_TAPSMITH_HOOKS=1` (the e2e workflows set it).
 */
function TapsmithHooks() {
  const { resetAppState } = useAuth()
  return <TapsmithTestHooks urlPrefix={Linking.createURL("/")} onReset={resetAppState} />
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <View style={styles.container}>
        <Stack
          screenOptions={{
            headerBackTitle: "Back",
          }}
        >
          <Stack.Screen name="index" options={{ title: "Tapsmith Test App" }} />
          <Stack.Screen name="__reset" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ title: "Login Form" }} />
          <Stack.Screen name="profile" options={{ title: "Profile" }} />
          <Stack.Screen name="list" options={{ title: "List" }} />
          <Stack.Screen name="toggles" options={{ title: "Toggles" }} />
          <Stack.Screen name="spinner" options={{ title: "Spinner" }} />
          <Stack.Screen name="gestures" options={{ title: "Gestures", gestureEnabled: false }} />
          <Stack.Screen name="dialogs" options={{ title: "Dialogs" }} />
          <Stack.Screen name="visibility" options={{ title: "Visibility" }} />
          <Stack.Screen name="accessibility" options={{ title: "Accessibility" }} />
          <Stack.Screen name="permissions" options={{ title: "Permissions" }} />
          <Stack.Screen name="clipboard" options={{ title: "Clipboard" }} />
          <Stack.Screen name="keychain" options={{ title: "Keychain" }} />
          <Stack.Screen name="slow-load" options={{ title: "Slow Load" }} />
          <Stack.Screen name="animating" options={{ title: "Animating" }} />
          <Stack.Screen name="scroll" options={{ title: "Scroll" }} />
          <Stack.Screen name="api-calls" options={{ title: "API Calls" }} />
          <Stack.Screen name="chat" options={{ title: "Chat" }} />
          <Stack.Screen name="occlusion" options={{ title: "Occlusion" }} />
          <Stack.Screen name="keyboard" options={{ title: "Keyboard" }} />
          <Stack.Screen name="webview" options={{ title: "WebView" }} />
        </Stack>
        <TapsmithHooks />
      </View>
    </AuthProvider>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
})
