# Trace Viewer

Tapsmith's trace viewer records screenshots, view hierarchy snapshots, console output, device logs and network traffic at each test step, then lets you scrub through a timeline to debug failures. It's the mobile-native equivalent of Playwright's Trace Viewer.

![Trace viewer showing a failed login test: timeline of screenshots, action log with the failed assertion, the app's error state, and the error with a source snippet](images/trace-viewer.png)

## Recording Traces

### Via configuration

Add `trace` to your `tapsmith.config.ts`:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  trace: "on", // Record every test
});
```

### Via CLI

Override the config with the `--trace` flag (a bare `--trace` means `on`; an unknown mode is an error that
lists the valid ones):

```bash
npx tapsmith test --trace on
npx tapsmith test --trace retain-on-failure
```

### Via programmatic API

Control tracing within your tests. Use this or a recording `trace` mode, not both: while the runner is already tracing the test (`--trace on`, a `trace` mode that records the attempt, such as `retain-on-failure`, and every run in [UI mode](ui-mode.md), which always traces), `device.tracing.start()` throws ([`device.tracing.start`](api-reference.md#devicetracingstartoptions)).

```typescript
import { test } from "tapsmith";

test("checkout flow", async ({ device }) => {
  await device.tracing.start();

  device.tracing.group("Add to cart");
  await device.getByText("Add to Cart", { exact: true }).tap();
  device.tracing.groupEnd();

  await device.tracing.stop({ path: "traces/checkout.zip" });
});
```

## Trace Modes

| Mode | Records on | Keeps trace when |
|------|-----------|-----------------|
| `off` | Never | — |
| `on` | Every attempt | Always |
| `on-first-retry` | First retry only | Always (when recorded) |
| `on-all-retries` | All retries | Always (when recorded) |
| `retain-on-failure` | Every attempt | Test fails |
| `retain-on-first-failure` | Every attempt | First attempt fails |
| `retain-on-failure-and-retries` | Every attempt | Run fails **or** is a retry |

**Recommended for CI:** `retain-on-failure` — minimal overhead on passing tests, full diagnostics on failures. Use `retain-on-failure-and-retries` when you want to keep both the failing and passing runs of flaky tests for comparison.

## Viewing Traces

### Online viewer

Open [trace.tapsmith.dev](https://trace.tapsmith.dev) and drag a `.zip` trace file onto the page, or load one via the `?trace=` URL parameter. The viewer runs entirely in your browser — no data is uploaded.

### Local viewer

```bash
npx tapsmith show-trace tapsmith-results/traces/trace-my_test-1767225600000.zip
```

This starts a local server and opens the trace viewer in your browser. It also prints the URL it
opened (`http://127.0.0.1:<port>/?trace=/trace.zip`), for opening the trace in another browser or
again after closing the tab; the server runs until you press Ctrl+C. A file that is not a readable
Tapsmith trace is refused in the terminal instead.

## Trace Viewer Panels

### Actions Panel (left)

Chronological list of all actions and assertions. Each entry shows:
- Action icon and name (tap, type, swipe, etc.)
- Locator used
- Wall-clock duration in milliseconds, including time between trace actions
- Pass/fail status (red highlight for failures)

Groups from `device.tracing.group()` appear as collapsible sections.

**Keyboard navigation:** Use arrow keys or `j`/`k` to move between actions.

### Timeline Filmstrip (top)

Horizontal strip of screenshot thumbnails. Click to jump to an action. Failed actions have a red border.

### Screenshot Panel (center)

Shows before/after screenshots for the selected action:
- **Before** — screenshot taken before the action executed
- **Action** — before screenshot with tap/swipe coordinate overlay
- **After** — the screen once the action completed: the next step's before screenshot, or, for the last step, a final screenshot taken when the test ends

On a device with more than one display, such as a foldable, the screenshots show the display the app is on, which changes when the device is folded or unfolded. If a screenshot fails with an error, the trace's Console tab says why, and the run output says so once. A screenshot that only times out is left out without a note.

### Detail Tabs (right)

- **Call** — Action type, locator, bounds, wall time, raw action/assertion time, wait time, retry count
- **Console** — Test code `console.log/warn/error` and device logs (Android logcat, iOS simulator syslog), color-coded by level. Each entry is timestamped — toggle between the offset from test start (`+1.234s`) and absolute wall-clock time with the `relative` / `absolute` pills; hovering shows the other format. Click a column header (Time, Level, Source, Message) to sort by it; click again to reverse. Timestamps are the time Tapsmith received the line, so device log entries — which arrive in batches — share a timestamp with the rest of their batch. In [UI mode](ui-mode.md) the live session isn't told when the test began, so offsets there are relative to the first console entry rather than to the test start
- **Source** — The actual source file for the selected step — test, helper, page object, or fixture — with the relevant line highlighted. When a step has a multi-frame call stack, a clickable call-stack pane lets you walk up the stack and view each frame's file. Files are captured at run time, so the code shown matches what actually ran even if you edit afterwards.
- **Hierarchy** — The view hierarchy (Android XML or iOS accessibility tree) with a searchable tree view
- **Network** — HTTP requests captured during the test (see [Network Capture](#network-capture) below)
- **Errors** — Error message, stack trace, and assertion expected/actual values

## Network Capture

Tapsmith can capture HTTP/HTTPS traffic from the device during test execution. Network requests are recorded alongside other trace data and displayed in the trace viewer's Network tab.

### Enabling network capture

Network capture is enabled by default when tracing is active. Control it with the `network` field in `TraceConfig`:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  trace: {
    mode: "retain-on-failure",
    network: true, // default — capture HTTP traffic
  },
});
```

To disable network capture while keeping other trace features:

```typescript
trace: {
  mode: "on",
  network: false,
}
```

### How it works

When a trace records network, each test starts capture at its beginning, on a local MITM proxy the Rust daemon starts once and keeps up for the session, with the device's traffic routed through it ([how capture works](network.md#how-capture-works)). Each request and response is recorded with method, URL, headers, status code, timing, and body data. HTTPS is decrypted with a CA certificate Tapsmith generates and installs on the device.

How traffic reaches the proxy depends on the platform: an `iptables` redirect on rootable Android emulators (the global HTTP proxy setting elsewhere), the macOS Network Extension on iOS simulators, and a Wi-Fi proxy profile on physical iOS devices. On Android and physical iOS the capture is device-wide, so other apps' traffic shows up too. See [How capture works](network.md#how-capture-works) for the details and [iOS network capture](./ios-network-capture.md) for the iOS setup (a one-time System Extension approval on simulators).

`network: false` only keeps traffic out of the trace. `device.route()` and the network waits work without a trace, because the proxy also starts for them (see [Network prerequisites](network.md#prerequisites)).

### Network tab in the trace viewer

The Network tab shows a sortable table of all captured requests:

| Column | Description |
|---|---|
| **Method** | HTTP method (GET, POST, PUT, etc.) |
| **URL** | Full request URL |
| **Status** | HTTP status code, color-coded (green for 2xx, blue for 3xx, yellow for 4xx, red for 5xx) |
| **Type** | Shortened content type (json, html, text, etc.) |
| **Duration** | Time from request start to response end |
| **Size** | Response body size |

Click a row to expand it and see full details:
- **Request headers** and **response headers**
- **Request body** and **response body** (JSON bodies are pretty-printed, and image bodies are shown as pictures with a **Raw** toggle)

Use the filter bar to search by URL and the status buttons (All / 2XX / 3XX / 4XX / 5XX) to narrow results. Click column headers to sort.

## Trace Archive Format

Traces are stored as `.zip` files containing:

```
trace.zip/
  metadata.json      # Format version, device and test info
  trace.json         # NDJSON event log
  screenshots/       # PNGs (action-003-before.png, action-003-after.png)
  hierarchy/         # View hierarchy XML snapshots
  sources.json       # Source files referenced by step call stacks, keyed by project-relative path
  network.json       # NDJSON network request log (when network capture is enabled)
  network/           # Request/response body files
```

`metadata.json` carries a format `version`. The viewer refuses a trace recorded in a newer format than it knows, and asks you to upgrade Tapsmith. It still opens traces recorded in older formats. See [Trace Archive Format](trace-format.md) for the full contract and its JSON Schema, which you'll need if you're building tooling that reads traces.

## CI Integration

### Capturing traces in GitHub Actions

```yaml
- name: Run tests
  run: npx tapsmith test --trace retain-on-failure

- name: Upload traces
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: tapsmith-traces
    path: tapsmith-results/traces/
    retention-days: 30
```

### Viewing CI traces

Download the trace artifact from your CI run and open it locally:

```bash
npx tapsmith show-trace tapsmith-results/traces/trace-login_test-1710345600000.zip
```

Or open [trace.tapsmith.dev](https://trace.tapsmith.dev) and drop the downloaded `.zip` file onto the page.

## Deep Linking

The trace viewer supports URL parameters for sharing specific views:

- `?trace=https://example.com/trace.zip` — load a trace from a URL
- `?action=5` — select the step at position 5 in the actions list, counting from 0 (the viewer keeps this parameter up to date as you select steps, so copying the address bar shares the current step)

For example: `https://trace.tapsmith.dev?trace=https%3A%2F%2Fexample.com%2Fartifacts%2Ftrace.zip&action=5`
