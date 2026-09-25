# Network Interception and Capture

Tapsmith provides Playwright-style network interception for mobile apps. You can mock API responses, abort requests, modify traffic in flight, and wait for specific network activity -- all from your test code. Network requests also appear in the trace viewer when capture is enabled. Traffic that cannot be decrypted can be tunneled instead: either by configuring `networkPassthroughHosts`, or automatically for HTTP/2-capable clients that reject Tapsmith's generated certificate.

This guide covers two related features:

1. **Network interception** -- route handlers that let you mock, modify, or block HTTP/HTTPS requests the app makes.
2. **Network capture** -- passive recording of all network traffic into traces for post-test inspection.

Both features share the same underlying MITM proxy infrastructure.

## Prerequisites

Network interception requires the MITM proxy to be active. The proxy starts automatically when tracing is enabled with `network: true` (the default). Without it, route handlers never fire and `waitForRequest`/`waitForResponse` never resolve.

Enable tracing in your config:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  trace: {
    mode: "on",
    network: true, // default when tracing is on
  },
})
```

Or from the CLI:

```bash
npx tapsmith test --trace on
```

The `--trace on` flag enables tracing with all defaults, including `network: true`. To disable network capture while keeping other trace features, set `network: false` in the config's object form:

```typescript
export default defineConfig({
  trace: { mode: 'on', network: false },
})
```

A `--trace <mode>` flag replaces the config's whole `trace` value, `network` included, so keep the mode in the config for this.

When network capture is off, `device.route()` silently registers the handler but it will never fire because no traffic passes through the proxy.

HTTP/2 traffic is intercepted when the client accepts Tapsmith's MITM CA — including gRPC, and including Firestore on Android. Clients that use embedded roots or certificate pinning reject external MITM certificates (Firestore on iOS always does); Tapsmith detects that rejection for HTTP/2-capable clients and tunnels later connections so the app keeps working, but route handlers and waiters cannot see the encrypted requests inside. See [HTTP/2, gRPC, and passthrough connections](#http2-grpc-and-passthrough-connections).

---

## Intercepting Requests with `device.route()`

### `device.route(url, handler, options?)`

Register a route handler that intercepts requests matching a URL pattern. The handler receives a `Route` object and must call one of `route.fulfill()`, `route.continue()`, `route.abort()`, or `route.fetch()` to resolve the request.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `url` | `string \| RegExp \| ((url: URL) => boolean)` | URL pattern to match |
| `handler` | `(route: Route) => Promise<void> \| void` | Handler function |
| `options.times` | `number` | Auto-remove after N matches |

### URL pattern forms

**Glob string** -- the most common form. `**` matches any path segment, `*` matches within a segment.

```typescript
// Match any request to the /api/posts endpoint
await device.route("**/api/posts", async (route) => {
  await route.fulfill({ json: [] })
})

// Match a specific host
await device.route("https://api.example.com/users/*", async (route) => {
  await route.fulfill({ json: { id: 1, name: "Test User" } })
})

// Match any request containing "graphql" in the path
await device.route("**/graphql", async (route) => {
  await route.fulfill({ json: { data: { viewer: null } } })
})
```

**RegExp** -- for complex matching patterns.

```typescript
// Match versioned API endpoints
await device.route(/\/api\/v[12]\/users/, async (route) => {
  await route.fulfill({ json: [] })
})

// Match requests with specific query parameters
await device.route(/\/search\?.*q=/, async (route) => {
  await route.fulfill({ json: { results: [] } })
})
```

**Predicate function** -- receives a `URL` object for full programmatic control.

```typescript
// Match POST requests to any API endpoint
await device.route(
  (url) => url.pathname.startsWith("/api/") && url.hostname === "example.com",
  async (route) => {
    if (route.request().method === "POST") {
      await route.fulfill({ status: 201, json: { created: true } })
    } else {
      await route.continue()
    }
  },
)
```

### Auto-removal with `times`

Limit how many requests a handler intercepts before it is automatically removed:

```typescript
// Only mock the first request, then let subsequent ones through
await device.route("**/api/config", async (route) => {
  await route.fulfill({ json: { featureFlag: true } })
}, { times: 1 })
```

---

## Route Actions

Every route handler receives a `Route` object. You must resolve the route by calling exactly one of these methods. If the handler returns without resolving, the request is continued upstream automatically (with a warning logged).

### `route.request()`

Returns the intercepted `TapsmithRequest` with properties: `method`, `url`, `headers`, `postData`, `isHttps`.

```typescript
await device.route("**/api/**", async (route) => {
  const request = route.request()
  console.log(`${request.method} ${request.url}`)
  console.log("Headers:", request.headers)
  if (request.postData) {
    console.log("Body:", request.postData.toString())
  }
  await route.continue()
})
```

### `route.fulfill(options?)`

Return a mock response without contacting the server. This is the primary method for mocking API responses.

| Option | Type | Default | Description |
|---|---|---|---|
| `status` | `number` | `200` | HTTP status code |
| `headers` | `Record<string, string>` | `{}` | Response headers |
| `body` | `string \| Buffer` | empty | Response body |
| `contentType` | `string` | auto | Content-Type header |
| `json` | `unknown` | -- | JSON-serializes and sets content-type to `application/json` |
| `path` | `string` | -- | Read the response body from a file |

**JSON mocking** (most common):

```typescript
await device.route("**/api/posts", async (route) => {
  await route.fulfill({
    json: [
      { id: 1, title: "First Post", author: "Alice" },
      { id: 2, title: "Second Post", author: "Bob" },
    ],
  })
})
```

**Custom status codes:**

```typescript
await device.route("**/api/protected", async (route) => {
  await route.fulfill({
    status: 401,
    json: { error: "Unauthorized", message: "Token expired" },
  })
})
```

**Response from a fixture file:**

```typescript
await device.route("**/api/products", async (route) => {
  await route.fulfill({
    path: "./fixtures/products.json",
    contentType: "application/json",
  })
})
```

**Custom headers:**

```typescript
await device.route("**/api/data", async (route) => {
  await route.fulfill({
    status: 200,
    headers: {
      "Cache-Control": "no-cache",
      "X-Request-Id": "test-123",
    },
    json: { data: "value" },
  })
})
```

### `route.abort(errorCode?)`

Abort the request, simulating a network failure. The app sees the request fail as if the network were unreachable.

| Error Code | Effect |
|---|---|
| (none) | Generic abort |
| `"connectionrefused"` | Connection refused |
| `"connectionreset"` | Connection reset |
| `"timedout"` | Request timed out |

```typescript
// Simulate a network timeout
await device.route("**/api/slow-endpoint", async (route) => {
  await route.abort("timedout")
})

// Block all analytics requests
await device.route("**/analytics/**", async (route) => {
  await route.abort()
})

// Simulate server unreachable
await device.route("**/api/health", async (route) => {
  await route.abort("connectionrefused")
})
```

### `route.continue(overrides?)`

Let the request proceed to the server with optional modifications. Use this to change the request before it reaches the backend.

| Override | Type | Description |
|---|---|---|
| `url` | `string` | Override the request URL. Supports same-origin paths and cross-origin redirection. |
| `method` | `string` | Override the HTTP method |
| `headers` | `Record<string, string>` | Override request headers |
| `postData` | `string \| Buffer` | Override the request body |

**Same-origin path change:**

```typescript
// Redirect v1 API calls to v2
await device.route("**/api/v1/**", async (route) => {
  const url = route.request().url.replace("/api/v1/", "/api/v2/")
  await route.continue({ url })
})
```

**Cross-origin redirection** (the Host header is auto-updated):

```typescript
// Redirect production API calls to a staging server
await device.route("https://api.example.com/**", async (route) => {
  const url = route.request().url.replace(
    "https://api.example.com",
    "https://staging.example.com",
  )
  await route.continue({ url })
})
```

**Adding an auth header:**

```typescript
await device.route("**/api/**", async (route) => {
  await route.continue({
    headers: {
      ...route.request().headers,
      "Authorization": "Bearer test-token-123",
    },
  })
})
```

**Modifying the request body:**

```typescript
await device.route("**/api/orders", async (route) => {
  const request = route.request()
  if (request.method === "POST" && request.postData) {
    const body = JSON.parse(request.postData.toString())
    body.testMode = true
    await route.continue({ postData: JSON.stringify(body) })
  } else {
    await route.continue()
  }
})
```

### `route.fetch(overrides?)`

Fetch the real response from the server, then inspect or modify it before fulfilling. This is the "modify response" pattern -- the most powerful interception mode.

`route.fetch()` accepts the same overrides as `route.continue()` (url, method, headers, postData). It returns a `FetchedAPIResponse` with:

| Property / Method | Type | Description |
|---|---|---|
| `status` | `number` | HTTP status code |
| `headers` | `Record<string, string>` | Response headers |
| `body()` | `Buffer` | Raw response body |
| `text()` | `string` | Body as UTF-8 string |
| `json()` | `unknown` | Body parsed as JSON |

After calling `route.fetch()`, you must call `route.fulfill()` to deliver the (potentially modified) response. You cannot call `route.abort()`, `route.continue()`, or `route.fetch()` again after fetching.

**Modify a JSON response:**

```typescript
await device.route("**/api/users/me", async (route) => {
  // Get the real response
  const response = await route.fetch()
  const user = response.json() as { name: string; email: string; plan: string }

  // Modify it
  user.plan = "premium"
  user.name = "Test User"

  // Return the modified response
  await route.fulfill({ json: user })
})
```

**Add a field to every API response:**

```typescript
await device.route("**/api/**", async (route) => {
  const response = await route.fetch()
  const data = response.json() as Record<string, unknown>

  // Inject a test flag
  data._testEnvironment = true

  await route.fulfill({
    status: response.status,
    headers: response.headers,
    json: data,
  })
})
```

**Remove sensitive fields from a response:**

```typescript
await device.route("**/api/users/*", async (route) => {
  const response = await route.fetch()
  const user = response.json() as Record<string, unknown>

  delete user.ssn
  delete user.creditCard

  await route.fulfill({ json: user })
})
```

**Fetch from a different server and return its response:**

```typescript
await device.route("**/api/feature-flags", async (route) => {
  // Fetch from the staging environment instead
  const response = await route.fetch({
    url: "https://staging.example.com/api/feature-flags",
  })

  await route.fulfill({
    status: response.status,
    headers: response.headers,
    body: response.body(),
  })
})
```

---

## Removing Route Handlers

### `device.unroute(url, handler?)`

Remove a previously registered route handler. If `handler` is omitted, all handlers for that URL pattern are removed.

```typescript
const handler = async (route: Route) => {
  await route.fulfill({ json: { mocked: true } })
}

// Register
await device.route("**/api/data", handler)

// Remove this specific handler
await device.unroute("**/api/data", handler)

// Or remove all handlers for this pattern
await device.unroute("**/api/data")
```

### `device.unrouteAll()`

Remove all registered route handlers at once.

```typescript
await device.unrouteAll()
```

**Best practice:** Call `device.unrouteAll()` in `afterEach` to prevent route handlers from leaking between tests:

```typescript
import { test, afterEach } from "tapsmith"

afterEach(async ({ device }) => {
  await device.unrouteAll()
})

test("mocked list", async ({ device }) => {
  await device.route("**/api/items", async (route) => {
    await route.fulfill({ json: [{ id: 1, name: "Mocked" }] })
  })
  // ...
})

test("real list", async ({ device }) => {
  // No route handler -- requests go to the real server
  // ...
})
```

---

## Waiting for Network Events

These methods let you wait for specific network activity without intercepting it. Useful for asserting that the app made the right API calls.

### `device.waitForRequest(urlOrPredicate, options?)`

Wait for an outgoing request matching the pattern. Returns a `TapsmithRequest`.

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `urlOrPredicate` | `string \| RegExp \| ((request: TapsmithRequest) => boolean)` | URL pattern or predicate |
| `options.timeout` | `number` | Timeout in ms (default: device timeout, 30s) |

```typescript
// Wait for a request by glob
const request = await device.waitForRequest("**/api/orders")
expect(request.method).toBe("POST")

// Wait for a request by RegExp
const req = await device.waitForRequest(/\/api\/v\d+\/users/)
console.log(req.url)

// Wait for a request matching a predicate
const createReq = await device.waitForRequest(
  (req) => req.url.includes("/api/orders") && req.method === "POST",
)
const body = JSON.parse(createReq.postData!.toString())
expect(body.items).toHaveLength(2)
```

### `device.waitForResponse(urlOrPredicate, options?)`

Wait for a response matching the pattern. Returns a `NetworkResponseEventData` with `method`, `url`, `status`, `headers`, `body`, and `routeAction`.

```typescript
// Wait for a successful response
const response = await device.waitForResponse("**/api/orders")
expect(response.status).toBe(200)

// Wait for a specific status code
const errorResponse = await device.waitForResponse(
  (resp) => resp.url.includes("/api/login") && resp.status === 401,
)

// Parse the response body
const resp = await device.waitForResponse("**/api/users/me")
const user = JSON.parse(resp.body!.toString())
expect(user.name).toBe("Alice")
```

### Combining waits with actions

The typical pattern is to start waiting before triggering the action that causes the network request:

```typescript
test("submitting the form creates an order", async ({ device }) => {
  // Start waiting BEFORE the tap that triggers the request
  const requestPromise = device.waitForRequest("**/api/orders")

  // Trigger the request
  await device.getByRole("button", { name: "Place Order" }).tap()

  // Now await the request
  const request = await requestPromise
  expect(request.method).toBe("POST")

  const body = JSON.parse(request.postData!.toString())
  expect(body.items).toHaveLength(3)
  expect(body.total).toBe(29.97)
})
```

---

## Subscribing to Network Events

For continuous monitoring (rather than waiting for a single event), use `device.on()` and `device.off()`.

### `device.on('request', handler)` / `device.on('response', handler)`

Subscribe to all request or response events.

```typescript
// Log all requests during a test
const requests: string[] = []
device.on("request", (req) => {
  requests.push(`${req.method} ${req.url}`)
})

// ... run test actions ...

console.log("Requests made:", requests)
```

### `device.off('request', handler)` / `device.off('response', handler)`

Unsubscribe from events. Pass the same function reference used with `device.on()`.

```typescript
const handler = (req: TapsmithRequest) => {
  console.log(req.url)
}

device.on("request", handler)
// ... later ...
device.off("request", handler)
```

---

## Practical Patterns

### Mocking an API endpoint

A complete test that mocks a list API and verifies the UI renders the mock data:

```typescript
import { test, expect } from "tapsmith"

test("displays mocked product list", async ({ device }) => {
  // Mock the API before the screen loads the data
  await device.route("**/api/products", async (route) => {
    await route.fulfill({
      json: [
        { id: 1, name: "Widget", price: 9.99, inStock: true },
        { id: 2, name: "Gadget", price: 19.99, inStock: false },
      ],
    })
  })

  // Navigate to the screen that fetches products
  await device.openDeepLink("myapp://products")

  // Verify the mocked data renders
  await expect(device.getByText("Widget")).toBeVisible()
  await expect(device.getByText("$9.99")).toBeVisible()
  await expect(device.getByText("Gadget")).toBeVisible()
  await expect(device.getByText("Out of Stock")).toBeVisible()
})
```

### Testing error states

Mock server errors and network failures to verify the app handles them correctly:

```typescript
import { test, expect } from "tapsmith"

test("shows error screen on server failure", async ({ device }) => {
  await device.route("**/api/products", async (route) => {
    await route.fulfill({
      status: 500,
      json: { error: "Internal Server Error" },
    })
  })

  await device.openDeepLink("myapp://products")
  await expect(device.getByText("Something went wrong")).toBeVisible()
  await expect(device.getByRole("button", { name: "Retry" })).toBeVisible()
})

test("shows offline banner on network failure", async ({ device }) => {
  await device.route("**/api/**", async (route) => {
    await route.abort("connectionrefused")
  })

  await device.openDeepLink("myapp://dashboard")
  await expect(device.getByText("No internet connection")).toBeVisible()
})

test("handles timeout gracefully", async ({ device }) => {
  await device.route("**/api/slow", async (route) => {
    await route.abort("timedout")
  })

  await device.getByRole("button", { name: "Load Data" }).tap()
  await expect(device.getByText("Request timed out")).toBeVisible()
})
```

### Modifying responses

Inject edge cases into real API responses to test boundary conditions:

```typescript
import { test, expect } from "tapsmith"

test("handles empty list from API", async ({ device }) => {
  await device.route("**/api/notifications", async (route) => {
    // Fetch the real response, then replace the items with an empty array
    const response = await route.fetch()
    const data = response.json() as { items: unknown[]; total: number }
    data.items = []
    data.total = 0
    await route.fulfill({ json: data })
  })

  await device.openDeepLink("myapp://notifications")
  await expect(device.getByText("No notifications yet")).toBeVisible()
})

test("handles extremely long names", async ({ device }) => {
  await device.route("**/api/users/me", async (route) => {
    const response = await route.fetch()
    const user = response.json() as { displayName: string }
    user.displayName = "A".repeat(200) // stress-test the UI with a very long name
    await route.fulfill({ json: user })
  })

  await device.openDeepLink("myapp://profile")
  // Verify the UI doesn't break -- name should be truncated or wrapped
  await expect(device.getByTestId("profile-name")).toBeVisible()
})
```

### Asserting on network traffic

Verify the app sends the correct requests with the right payloads:

```typescript
import { test, expect } from "tapsmith"

test("search sends the right query parameters", async ({ device }) => {
  const requestPromise = device.waitForRequest("**/api/search**")

  await device.getByPlaceholder("Search products").type("wireless headphones")
  await device.getByRole("button", { name: "Search" }).tap()

  const request = await requestPromise
  expect(request.method).toBe("GET")
  expect(request.url).toContain("q=wireless+headphones")
})

test("checkout sends correct order payload", async ({ device }) => {
  const requestPromise = device.waitForRequest(
    (req) => req.url.includes("/api/orders") && req.method === "POST",
  )

  await device.getByRole("button", { name: "Place Order" }).tap()

  const request = await requestPromise
  const body = JSON.parse(request.postData!.toString())
  expect(body.items).toHaveLength(2)
  expect(body.currency).toBe("USD")
})

test("login sends credentials to the right endpoint", async ({ device }) => {
  const [request, response] = await Promise.all([
    device.waitForRequest("**/api/auth/login"),
    device.waitForResponse("**/api/auth/login"),
    // Trigger the login
    device.getByRole("button", { name: "Sign In" }).tap(),
  ])

  expect(request.method).toBe("POST")
  expect(request.isHttps).toBe(true)
  expect(response.status).toBe(200)
})
```

### Mocking once, then letting through

Use `times` to mock only the first request (e.g., show cached data on initial load, then real data on refresh):

```typescript
import { test, expect } from "tapsmith"

test("pull-to-refresh fetches fresh data", async ({ device }) => {
  // First load returns stale data
  await device.route("**/api/feed", async (route) => {
    await route.fulfill({
      json: [{ id: 1, title: "Cached Item" }],
    })
  }, { times: 1 })

  await device.openDeepLink("myapp://feed")
  await expect(device.getByText("Cached Item")).toBeVisible()

  // Pull-to-refresh hits the real server (route was auto-removed after 1 match)
  await device.swipe("down")
  // The real server's response will render now
})
```

---

## Network Capture in Traces

When tracing is enabled with `network: true`, all HTTP/HTTPS traffic from the device is recorded in the trace archive. This is separate from route interception -- capture records passively, while interception lets you modify traffic.

### How capture works

The Rust daemon (`tapsmith-core`) runs a local MITM proxy. Traffic routing depends on the platform:

| Platform | Mechanism | Scope |
|---|---|---|
| **Android** | `iptables` transparent redirect (rooted emulator images), falling back to the global HTTP proxy setting | All apps on the emulator/device |
| **iOS simulator** | macOS Network Extension (per-PID filtering) | Only the simulator's process tree |
| **iOS physical** | Wi-Fi proxy via `.mobileconfig` profile | System-wide (all apps on the device) |

HTTPS is decrypted using an auto-generated CA certificate installed on the device. On iOS simulators, this is injected transparently via `xcrun simctl keychain add-root-cert`. On Android, it is installed into the system trust store via `adb root`, which requires a rootable emulator image — see [Android emulator image requirements](#android-emulator-image-requirements). Apps or SDKs that use embedded roots, certificate pinning, custom TLS verification, or another transport Tapsmith cannot speak may still reject that CA. Configure `networkPassthroughHosts` for those hosts; HTTP/2-capable clients that reject the generated certificate may also be tunneled dynamically.

Captured requests appear in the trace viewer's **Network tab** alongside screenshots, view hierarchy snapshots, and console output.

In UI mode, the Network panel refreshes about every 500 ms during a test. Each refresh replaces the previous snapshot; open HTTP/2 streams keep their row and update their captured bodies and sizes as data arrives. The final trace includes the last cumulative snapshot. The empty-panel capture hint appears only when network capture is disabled in the trace configuration.

### Local Firebase emulators and custom HTTP ports

On a rootable Android emulator, add the local services' cleartext ports to your
trace configuration:

```typescript
trace: {
  mode: 'on',
  network: true,
  networkHttpPorts: [8080, 9099, 5001, 9199],
}
```

Ports 80 and 443 remain included. The extra ports support HTTP/1.1 and HTTP/2
prior knowledge (h2c), which Firestore uses on its emulator port. For these
transparent cleartext HTTP/1.1 and h2c connections, Tapsmith dials Android's `10.0.2.2` host alias as host loopback while preserving the original
host and port in captured URLs. This translation applies only to Android
emulators; TLS and forward-proxy connections do not translate the alias. Open Firestore listeners appear with live, cumulative body snapshots.
Start capture before opening the connection, or restart the app during the test;
connections that were already open cannot be redirected retroactively.

`networkHttpPorts` configures Android's transparent redirect; it requires
iptables support and is for **cleartext HTTP ports**, not additional TLS ports.

### HTTP/2, gRPC, and passthrough connections

Capture decrypts and records both **HTTP/1.1** and **HTTP/2** traffic when the client accepts Tapsmith's MITM certificate. Most mobile HTTP clients (URLSession, OkHttp, fetch/axios) offer both protocols during the TLS handshake; the proxy negotiates HTTP/1.1 with them (server preference) and captures normally.

Clients that *require* HTTP/2, such as gRPC libraries, can be captured too: the proxy speaks HTTP/2 to the app and to the origin, forwarding DATA frames and trailers (so `grpc-status` is preserved) while recording each request/response. `device.route()`, `device.waitForRequest()`, and `device.waitForResponse()` work for those requests only when the client trusts the generated Tapsmith certificate.

Some clients do not trust the device or simulator trust store. Firestore is the common example, and it behaves differently per platform:

- **Android: Firestore is captured.** Its gRPC stack (gRPC-Java) validates TLS against the platform trust store, so once Tapsmith has installed its CA there, Firestore calls are decrypted and recorded like any other HTTP/2 traffic — each RPC appears as an inspectable request/response, and `device.route()` can match and mock it. This needs a rootable emulator image so the CA reaches the *system* store; see [Android emulator image requirements](#android-emulator-image-requirements).
- **iOS: Firestore is tunnelled.** Its gRPC stack (gRPC-C++/BoringSSL) compiles its own CA roots into the app binary and passes them explicitly, so it rejects Tapsmith's certificate no matter what the device trust store contains. No configuration changes that. `firestore.googleapis.com` is therefore **tunnelled by default on iOS**, which keeps Firestore-backed screens working out of the box at the cost of not being able to inspect those calls.

Firestore RPC bodies are protobuf rather than JSON. The trace viewer decodes them: a gRPC body is split into its length-prefixed messages and each is shown as protobuf fields, with a **Raw** toggle for the underlying bytes.

Protobuf carries field *numbers* on the wire, never names, so the baseline output is numeric (`1: "projects/demo/databases/(default)"`, in the style of `protoc --decode_raw`). For services Tapsmith knows — currently Firestore's `Listen` — a built-in name table lifts that to real field names, resolves enums, unpacks repeated scalars and formats timestamps:

```
── message 3 of 64 (902 bytes)
  document_change {
    document {
      name: "projects/demo/databases/(default)/documents/users/u1"
      fields:
        displayName: { string_value: "E2E Test User" }
        onboardingCompletedAt: { timestamp_value: 2026-06-10T11:29:35.776Z }
        onboardingCompleted: { boolean_value: true }
    }
    target_ids: [2]
  }
```

A body with more than a few messages is led by a per-kind summary, because a long stream is mostly bookkeeping — this one carries two document changes among sixty target acks, and the tallies also make listener churn obvious:

```
── summary of 64 messages
   target_change   ×60  target_change_type: NO_CHANGE ×23, ADD ×13, CURRENT ×12, REMOVE ×12
   document_change ×2   "…/documents/users/u1"
   filter          ×2
```

Unknown services fall back to numbers rather than guessing. Repeated fields are marked `[]` so a single-element list is not mistaken for a scalar, compressed messages are listed but not inflated (the codec lives in `grpc-encoding`), and a body truncated by the capture cap says how much is missing.

**Open streams are visible too.** A long-lived `Listen` appears in the Network tab marked **Streaming**, with the request and response headers and body bytes captured so far. Complete gRPC messages decode normally; a final incomplete frame is labelled truncated. The HTTP status is the response's header status, not proof that the RPC finished; `grpc-status` only appears if the server has sent it.

Each test takes a **frozen, cumulative snapshot** when its capture ends. A stream spanning several tests appears once in each test's trace, with its original start time, elapsed duration and all bytes captured since it opened (up to 1 MiB per direction). Requests that began before the test are labelled **Started before this test**. Their Time column and waterfall show only the period observed during the current test. The Timing detail retains the original start timestamp and shows **Stream age** (or **Total request duration** after completion) separately from **Observed during this test**. Bodies and byte counts remain cumulative, and the detail panel states this explicitly. Later snapshots may contain more messages; earlier traces do not change. When the stream closes, the next capture contains one completed row, with no duplicate streaming row. Bodies remain capped per open stream, and cancelled stream tasks release their capture buffers.

For any other HTTP/2-capable host that rejects the certificate — including Firestore on Android when the CA only reached the *user* trust store — Tapsmith detects the rejection and tunnels later connections for the same SNI. The rejection is recognised both when the client sends a TLS alert (`unknown_ca`, `bad_certificate`) and when it simply tears the connection down without one — gRPC-C++/BoringSSL stacks abort with a connection reset rather than a decodable alert, so this abrupt-close case is treated as a rejection once it repeats for a host. The app continues to work, and the trace shows a single `CONNECT` row marked `passthrough`, but the encrypted requests inside are not available to `device.route()`, `device.waitForRequest()`, `device.waitForResponse()`, or the trace viewer.

A few HTTP/2 specifics to be aware of:

- **Long-lived channels are opened once per app process.** gRPC clients (Firestore included) multiplex every call over a single h2 connection. If the app was already running when your test started, that connection already exists and nothing new crosses the proxy, so `waitForRequest`/`waitForResponse` never fire and `route()` handlers never match -- capture looks broken while working correctly. Relaunch the app inside the test (`device.launchApp(...)`) so the channel is opened during the window you are waiting on.
- **Streaming / long-lived calls** (e.g. Firestore `Listen`) are forwarded incrementally and appear in the trace even while open, with a **Streaming** marker and a snapshot of their partial bodies. Assert on the *request* event, which fires when the stream opens; a `waitForResponse` on a stream that never ends will time out.
- Captured HTTP/2 header names are lowercase (that's how HTTP/2 sends them on the wire).
- Request/response **bodies in the trace are capped** (~1 MB), but the full stream is always forwarded to the app.

Hosts listed in `networkPassthroughHosts`, and HTTP/2-capable hosts that dynamically fall back after a MITM certificate rejection, are tunneled end-to-end without decryption (see below). A tunneled connection appears in the Network tab as a single `CONNECT` row with a `passthrough` badge; the requests inside are encrypted end-to-end and invisible to the proxy, so `device.route()` / `waitForRequest` / `waitForResponse` can never match them.

Force passthrough for specific hosts with `networkPassthroughHosts` -- useful when an app uses **certificate pinning** for a host, which MITM interception would otherwise break:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  trace: {
    mode: "on",
    networkPassthroughHosts: ["pinned-api.myapp.com"],
  },
})
```

Patterns match against the TLS SNI hostname with the same glob syntax as `networkHosts`.

Because passthrough connections are never decrypted, `device.route()`, `device.waitForRequest()`, and `device.waitForResponse()` can never match traffic on them. If a mock for a host you've added to `networkPassthroughHosts` never fires, or a Firestore/pinned-host request only appears as `CONNECT passthrough`, this is why.

### Viewing network data in traces

Open a trace archive:

```bash
npx tapsmith show-trace tapsmith-results/traces/trace-my_test.zip
```

The Network tab shows a sortable table with columns for method, URL, status code, content type, duration, and response size. Click a row to expand request/response headers and bodies. JSON bodies are pretty-printed automatically, and gRPC/protobuf bodies are decoded into their messages and fields (see [HTTP/2, gRPC, and passthrough connections](#http2-grpc-and-passthrough-connections)) with a **Raw** toggle for the original bytes.

Route handler actions also appear as events in the trace viewer's actions panel (e.g., `route.fulfill`, `route.abort`), with the source location of your handler code highlighted.

### API request fixture in traces

When using the `request` fixture for test-level API calls (seeding data, checking backend state), those calls also appear in the Network tab and the actions panel:

```typescript
test("shows created item", async ({ device, request }) => {
  // This POST appears in the trace
  await request.post("https://api.example.com/items", {
    data: { name: "Test Item" },
  })

  await device.getByText("Refresh").tap()
  await expect(device.getByText("Test Item")).toBeVisible()
})
```

### Filtering captured traffic

On Android and iOS physical devices, the proxy captures traffic from all apps, not just the app under test. System services, Google Play, Apple background tasks, and other apps all show up. Use `networkHosts` and `networkIgnoreHosts` to control what ends up in the trace.

**Allowlist** -- only keep traffic from your app's API hosts:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  trace: {
    mode: "retain-on-failure",
    networkHosts: ["*.myapp.com", "api.partner.example"],
  },
})
```

**Denylist** -- keep everything except known noise:

```typescript
import { defineConfig } from "tapsmith"

export default defineConfig({
  trace: {
    mode: "on",
    networkIgnoreHosts: [
      // Android emulator system traffic
      "connectivitycheck.gstatic.com",
      "*.googleapis.com",
      "play.googleapis.com",
      "mtalk.google.com",
      "android.clients.google.com",
      "www.google.com",
      "clients*.google.com",
      // iOS background traffic (physical devices)
      "*.apple.com",
      "*.icloud.com",
      "captive.apple.com",
    ],
  },
})
```

Both fields accept glob patterns. Matching is case-insensitive. When both are set, an entry is kept only if it matches the allowlist AND does not match the denylist -- deny wins on conflicts.

iOS simulators are already per-PID filtered by the macOS Network Extension, so system noise is minimal. The filters still work there for additional cleanup if needed.

### Platform differences

**Android emulators/devices:** On rootable emulator images, traffic is redirected to the proxy transparently with `iptables`. Where root is unavailable, the HTTP proxy is instead set globally via `adb shell settings put global http_proxy`. Either way, every app and system service on the device routes through it -- use `networkHosts` or `networkIgnoreHosts` to reduce noise in traces. HTTPS decryption additionally requires a rootable (non-Play) emulator image; see [Android emulator image requirements](#android-emulator-image-requirements).

**iOS simulators:** The macOS Network Extension intercepts traffic per-PID, filtering to only the simulator's process tree. Parallel iOS workers each get their own isolated capture session. Host browser traffic is never affected. See [iOS Network Capture](ios-network-capture.md) for first-run setup (a one-time System Extension approval).

**iOS physical devices:** A Wi-Fi proxy configuration profile (`.mobileconfig`) routes the device's traffic through the host Mac. This is system-wide -- there is no per-app filtering at the OS level. Use `networkHosts` to scope what appears in the trace. See [iOS Network Capture](ios-network-capture.md#physical-ios-devices) for the device-specific setup flow.

### Android emulator image requirements

HTTPS decryption on Android emulators requires `adb root`, which only works on **Google APIs** (`google_apis`) and AOSP system images. **Google Play** images (`google_apis_playstore`) are production builds on which `adbd` cannot restart as root, so Tapsmith cannot install its CA certificate into the system trust store or set up the `iptables` redirect. On a Play image, tests still run and plain-HTTP traffic is still captured through the global proxy fallback, but HTTPS traffic is not decrypted and Tapsmith prints this at startup:

```
Network capture warning: Failed to install CA cert on device: Device does not support
adb root — this emulator runs a Google Play (google_apis_playstore) system image,
which blocks root. Recreate the AVD with a Google APIs image (`npx tapsmith create-avd`)
to enable HTTPS capture — HTTPS traffic will not be captured
iptables redirect unavailable; using Android system HTTP proxy fallback
```

Android Studio's Device Manager preselects Google Play images for most phone profiles (marked with a Play Store icon next to the system image). When creating an AVD for Tapsmith, pick an image from the **Google APIs** tab instead — or let Tapsmith do it:

```bash
npx tapsmith create-avd
```

This downloads the Google APIs system image for your host architecture and creates a ready-to-use AVD (`Tapsmith_Phone_API_36` by default; see `npx tapsmith create-avd --help` for `--api`, `--name`, `--device`, and `--abi`). If the Android SDK command-line tools are missing — Android Studio doesn't install them by default — the command offers to install those too. The equivalent manual commands:

```bash
sdkmanager "system-images;android-36;google_apis;arm64-v8a"   # use x86_64 on Intel hosts
avdmanager create avd -n Tapsmith_Phone_API_36 \
  -k "system-images;android-36;google_apis;arm64-v8a" -d medium_phone
```

`npx tapsmith doctor` flags any existing AVD that uses a Google Play image.

To check an existing AVD, look at `tag.id` in `~/.android/avd/<name>.avd/config.ini`: `google_apis` (or `default`/`aosp_atd`) supports HTTPS capture; `google_apis_playstore` does not.

Manually installing `~/.tapsmith/ca.pem` as a *user* CA on a Play image is possible but rarely sufficient: apps targeting API 24+ do not trust user-installed CAs unless they opt in via `network_security_config.xml`. Unless your test build has that opt-in, use a Google APIs image instead.

---

## Reference

- [API Reference](api-reference.md) -- full method signatures for `device.route()`, `Route`, `TapsmithRequest`, and related types
- [Trace Viewer](trace-viewer.md) -- how to view and navigate trace archives
- [Configuration](configuration.md) -- `TraceConfig` options including `network`, `networkHosts`, `networkIgnoreHosts`, `networkPassthroughHosts`
- [iOS Network Capture](ios-network-capture.md) -- iOS-specific setup, troubleshooting, and the Network Extension architecture
