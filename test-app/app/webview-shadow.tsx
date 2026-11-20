import { StyleSheet, Text, View } from "react-native"
import { WebView } from "react-native-webview"

// Web components in the shape Ionic, Stencil and Lit give them: the native
// control lives in an open shadow root, the label text is slotted in from the
// light DOM, an aria-label set on the host is moved onto the inner control,
// and every shadow root carries its own <style>. One component uses a closed
// shadow root, which locators must not reach (as in Playwright).
const HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, sans-serif; padding: 20px; margin: 0; background: #f9f9f9; }
    x-button, x-field, x-icon-button, x-closed-button { display: block; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Shadow DOM Components</h1>

  <x-field id="display-name" label="Display name" placeholder="Your display name"></x-field>

  <x-button id="save-draft">Save draft</x-button>

  <x-icon-button id="dismiss" aria-label="Dismiss banner"></x-icon-button>

  <x-closed-button id="closed"></x-closed-button>

  <p id="shadow-status">Nothing yet</p>

  <script>
    var statusEl = document.getElementById('shadow-status');

    customElements.define('x-button', class extends HTMLElement {
      constructor() {
        super();
        var root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>.button-native { padding: 12px 24px; border-radius: 6px; border: none; background: #007AFF; color: white; font-size: 16px; width: 100%; }</style>'
          + '<button class="button-native" type="button"><span class="button-inner"><slot></slot></span></button>';
        root.querySelector('button').addEventListener('click', function () {
          statusEl.textContent = 'Draft saved';
        });
      }
    });

    customElements.define('x-field', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        var root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>label { display: block; font-weight: 600; } input { width: 100%; padding: 10px; font-size: 16px; box-sizing: border-box; }</style>'
          + '<label for="native-input"></label><input id="native-input" data-testid="display-name-input">';
        root.querySelector('label').textContent = this.getAttribute('label');
        var input = root.querySelector('input');
        // Moved, not copied, as Ionic's inheritAttributes does: left on the
        // host too, getByPlaceholder would match both.
        input.placeholder = this.getAttribute('placeholder');
        this.removeAttribute('placeholder');
        input.addEventListener('input', function () {
          statusEl.textContent = 'Hello, ' + input.value;
        });
      }
    });

    customElements.define('x-icon-button', class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        var root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>button { width: 44px; height: 44px; }</style><button type="button">&#x2715;</button>';
        var button = root.querySelector('button');
        // Ionic's inheritAriaAttributes: the host's aria-label moves to the control.
        button.setAttribute('aria-label', this.getAttribute('aria-label'));
        this.removeAttribute('aria-label');
        button.addEventListener('click', function () {
          statusEl.textContent = 'Banner dismissed';
        });
      }
    });

    customElements.define('x-closed-button', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'closed' }).innerHTML = '<button type="button">Hidden action</button>';
      }
    });
  </script>
</body>
</html>
`

export default function WebViewShadowScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.label} accessibilityRole="header">
        Shadow DOM WebView
      </Text>
      <View style={styles.webviewContainer}>
        <WebView
          source={{ html: HTML_CONTENT }}
          style={styles.webview}
          webviewDebuggingEnabled={true}
          javaScriptEnabled={true}
          testID="shadow-webview"
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
