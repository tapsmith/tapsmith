import { Pressable, StyleSheet, Text, View } from "react-native"
import * as WebBrowser from "expo-web-browser"
import { WebView } from "react-native-webview"

const HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, sans-serif; padding: 20px; margin: 0; background: #f9f9f9; }
    h1.header { color: #1a1a1a; margin-bottom: 16px; }
    p.description { color: #666; margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 4px; color: #333; }
    input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 16px; box-sizing: border-box; }
    button#login-button { background: #007AFF; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; cursor: pointer; width: 100%; }
    button#login-button:active { background: #0056b3; }
    .success-message { display: none; background: #d4edda; color: #155724; padding: 12px; border-radius: 6px; margin-top: 16px; }
    .success-message.visible { display: block; }
    a.test-link { color: #007AFF; display: block; margin-top: 16px; }
    .counter { margin-top: 16px; color: #666; }
    button#increment-button { background: #28a745; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 8px; }
  </style>
</head>
<body>
  <h1 class="header">WebView Test Page</h1>
  <p class="description">This page tests WebView interaction via CDP.</p>

  <div class="form-group">
    <label for="email">Email</label>
    <input id="email" type="email" placeholder="Enter your email">
  </div>

  <div class="form-group">
    <label for="password">Password</label>
    <input id="password" type="password" placeholder="Enter your password">
  </div>

  <button id="login-button" onclick="handleLogin()">Login</button>

  <div class="success-message" id="success-msg">Login successful!</div>

  <a class="test-link" href="#" onclick="return false;">Forgot password?</a>

  <div class="counter">
    <span id="count-display">Count: 0</span>
    <br>
    <button id="increment-button" onclick="handleIncrement()">Increment</button>
  </div>

  <script>
    var count = 0;

    function handleLogin() {
      var email = document.getElementById('email').value;
      var password = document.getElementById('password').value;
      if (email && password) {
        document.getElementById('success-msg').classList.add('visible');
      }
    }

    function handleIncrement() {
      count++;
      document.getElementById('count-display').textContent = 'Count: ' + count;
    }
  </script>
</body>
</html>
`

/** Any page: the browser's own controls are what is tested, not its content. */
const IN_APP_BROWSER_URL = "https://example.com"

export default function WebViewScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.label} accessibilityRole="header">
        Embedded WebView
      </Text>
      {/* An in-app browser (SFSafariViewController / Custom Tabs), which
          another process draws over the app (PILOT-1384). */}
      <Pressable
        accessibilityRole="button"
        onPress={() => void WebBrowser.openBrowserAsync(IN_APP_BROWSER_URL)}
        style={styles.browserButton}
      >
        <Text style={styles.browserButtonText}>Open in-app browser</Text>
      </Pressable>
      {/* Named like the in-app browser's own Done button. Covered by the
          browser, it is left out of the app's snapshot but not out of
          XCTest's live queries, so a locator for the browser's Done must not
          bind this one (PILOT-1384). */}
      <Pressable accessibilityRole="button" onPress={() => {}} style={styles.doneButton}>
        <Text style={styles.doneButtonText}>Done</Text>
      </Pressable>
      <View style={styles.webviewContainer}>
        <WebView
          source={{ html: HTML_CONTENT }}
          style={styles.webview}
          webviewDebuggingEnabled={true}
          javaScriptEnabled={true}
          testID="test-webview"
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f5f5f5",
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1a1a1a",
    padding: 16,
    paddingBottom: 8,
  },
  browserButton: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
    alignItems: "center",
    backgroundColor: "#007AFF",
    borderRadius: 6,
  },
  browserButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  doneButton: {
    alignSelf: "flex-end",
    marginHorizontal: 16,
    marginBottom: 8,
  },
  doneButtonText: {
    color: "#007AFF",
    fontSize: 15,
  },
  webviewContainer: {
    flex: 1,
    margin: 8,
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  webview: {
    flex: 1,
  },
})
