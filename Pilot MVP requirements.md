# Pilot — Native Mobile App Test Framework

## Project Summary

Pilot is a next-generation native mobile app testing framework that aims to bring Playwright-level reliability and developer experience to mobile. The core runtime is written in Rust. The user-facing SDK and test runner are TypeScript. The MVP targets Android only.

The guiding philosophy: **direct protocol-level control, zero flakiness, zero config.**

---

## Architecture Overview

Pilot has three layers:

1. **Rust Core Daemon (`pilot-core`)** — A long-running process on the host machine that manages device/emulator connections via ADB, communicates with the on-device agent, and exposes a gRPC API to the TypeScript SDK.

2. **On-Device Agent (`pilot-agent`)** — A lightweight Android instrumentation APK installed alongside the app under test. It runs inside the Android Instrumentation framework, giving it direct access to the UI hierarchy via UIAutomator2/Accessibility APIs. It receives commands from the Rust daemon over a local socket (forwarded via ADB).

3. **TypeScript SDK + Test Runner (`pilot`)** — The npm package developers install. Provides the public API (`pilot.tap()`, `pilot.type()`, etc.), a test runner with `describe`/`it` blocks, and configuration. Communicates with the Rust daemon via gRPC.

```
┌─────────────────────┐       gRPC        ┌──────────────────┐      ADB/socket      ┌──────────────────────┐
│  TypeScript SDK      │ ◄──────────────► │  Rust Core Daemon │ ◄──────────────────► │  On-Device Agent     │
│  (test runner)       │                   │  (pilot-core)     │                      │  (pilot-agent.apk)   │
│                      │                   │                   │                      │  UIAutomator2 access │
└─────────────────────┘                   └──────────────────┘                      └──────────────────────┘
```

---

## MVP Scope

The MVP delivers **core interactions on Android** with rock-solid reliability. Nothing else until these are bulletproof.

### Core Interactions

These are the fundamental actions the framework must support:

- **`tap(selector)`** — Tap an element. Must auto-wait for the element to be visible, enabled, and stable (not animating) before tapping.
- **`longPress(selector, duration?)`** — Long press an element with configurable duration.
- **`type(selector, text)`** — Focus a text input and type text character by character. Must handle keyboard appearance/dismissal.
- **`clearAndType(selector, text)`** — Clear existing text in an input, then type new text.
- **`swipe(direction, options?)`** — Swipe up/down/left/right from a starting point. Configurable speed, distance, and starting element.
- **`scroll(selector, direction, options?)`** — Scroll a scrollable container. Must support scrolling until an element is found (`scrollUntilVisible`).
- **`pressKey(key)`** — Press a device key (back, home, enter, volume, etc.).
- **`pressBack()`** — Convenience for Android back button.

### Element Selection (Selectors)

Selectors follow a strict priority hierarchy inspired by Testing Library's guiding principle: **tests should interact with the app the way users do.** Queries that rely on accessibility semantics are preferred over implementation details. The docs, examples, and lint rules should all push developers toward the top of this list.

#### Priority 1 — Accessible to Everyone (strongly recommended)

These queries reflect what assistive technologies and real users see. They should be the default choice.

- **`role('button', 'Submit')`** — Find by accessibility role + accessible name. Maps semantic role names (button, textfield, checkbox, switch, image, heading, link, list, listitem) to Android widget classes and their subclasses (including Material/AppCompat variants). The `name` parameter matches against the element's text or `contentDescription`. This is the **top recommended selector** — it tests that the app is accessible while also being resilient to refactors.
- **`text("Welcome back")`** — Find by visible text (exact match). Use for asserting visible content or interacting with text-labeled elements that don't have a distinct role.
- **`textContains("Welcome")`** — Find by partial visible text.
- **`contentDesc("Close menu")`** — Find by accessibility content description. Use for icon buttons, images, and other elements where the accessible label differs from visible text.

#### Priority 2 — Semantic Queries (acceptable)

These use Android-specific semantics. Fine when Priority 1 selectors don't fit.

- **`hint("Enter your email")`** — Find by input hint text (Android `hint` attribute). Equivalent to placeholder text. Good for finding text fields by their label when no visible label element exists.
- **`className("android.widget.Switch")`** — Find by exact Android class name. Use when role mapping doesn't cover a custom widget.

#### Priority 3 — Test IDs (escape hatch)

These are invisible to the user. Use them only when the above strategies genuinely cannot work.

- **`testId("submit-button")`** — Find by a dedicated test identifier. On Android, this maps to the view's `tag` or a custom `contentDescription` prefix (e.g., `testid:submit-button`). The recommended convention is to use `ViewCompat.setAccessibilityPaneTitle` or a custom view tag. Document both approaches and let teams choose.
- **`id("com.app:id/button_submit")`** — Find by Android resource ID. This is a concession to reality — many existing apps already have resource IDs and it's the fastest way to write tests. But IDs are implementation details that break on refactors, so docs should discourage reliance on them.

#### Priority 4 — Low-level (discouraged)

Supported but actively discouraged in docs and flagged by the linter.

- **`xpath("//...")`** — XPath query on the view hierarchy. Fragile, verbose, and tightly coupled to the view structure. Exists only as an escape hatch for edge cases.

#### Chaining and Scoping

All selectors support scoping within a parent element:

```typescript
// Find "Item 3" inside a specific list
await device.element(role("list", "Shopping cart")).element(text("Item 3"));

// Tap the delete button inside a specific row
await device.element(testId("row-5")).element(role("button", "Delete"));
```

#### Linter / Best Practices Enforcement

The `pilot` package should include an ESLint plugin (`eslint-plugin-pilot`) that:

- Warns when using `testId()`, `id()`, or `xpath()` if a Priority 1 selector could work.
- Errors on bare `xpath()` usage without an explanatory comment.
- Suggests `role()` alternatives when `className()` is used for standard widgets.

### Auto-Waiting

This is the #1 differentiator. Every action must auto-wait with these conditions before acting:

1. Element exists in the UI hierarchy.
2. Element is visible (not obscured, not zero-size).
3. Element is enabled (clickable/focusable as appropriate).
4. UI is idle — no pending animations, no layout passes in progress. Use `UiDevice.waitForIdle()` and monitor `AccessibilityEvent` streams.
5. Configurable timeout (default 30s) with clear timeout error messages that include what condition was not met.

**No polling loops.** Use Android's accessibility event stream to react to UI changes. This is how you achieve Playwright-level reliability.

### Assertions

Built-in assertions that also auto-wait:

- **`expect(selector).toBeVisible()`**
- **`expect(selector).toBeEnabled()`**
- **`expect(selector).toHaveText("...")`**
- **`expect(selector).toExist()`**
- **`expect(selector).not.toBeVisible()`** — Waits for element to disappear.

### Device/Emulator Management

The daemon must handle:

- Auto-detecting connected devices and running emulators via ADB.
- Installing the agent APK and the app under test automatically.
- Port forwarding for the socket connection between daemon and agent.
- Clear error messages if no device is found, ADB isn't installed, etc.

For MVP, the user is responsible for starting their emulator or connecting their device. Pilot just detects and connects.

---

## Reliability Requirements

These are non-negotiable. The framework is worthless without them.

1. **Deterministic execution.** Given the same app state, the same test must produce the same result 100% of the time. No "run it again and it'll pass."
2. **No arbitrary sleeps.** Never `Thread.sleep()` or `setTimeout()` in the framework internals. All waiting is event-driven.
3. **Graceful failure.** When something goes wrong, the error message must tell the developer exactly what happened: which element, what state it was in, what was expected, and a screenshot of the device at the moment of failure.
4. **Automatic screenshots on failure.** Every failed action/assertion captures a screenshot and attaches it to the test report.
5. **Stable under load.** Running 20+ tests sequentially on one device must not degrade. No memory leaks in the agent, no ADB connection drops.

---

## TypeScript API Design

The API should feel immediately familiar to Playwright users.

```typescript
// pilot.config.ts
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app/build/outputs/apk/debug/app-debug.apk",
  timeout: 30_000,
  retries: 0,
  screenshot: "only-on-failure",
});

// tests/login.test.ts
import { test, expect } from "pilot";

test("user can log in", async ({ device }) => {
  await device.type(id("email_input"), "user@example.com");
  await device.type(id("password_input"), "password123");
  await device.tap(text("Sign In"));

  await expect(device.element(text("Welcome back"))).toBeVisible();
});

test("shows error on invalid credentials", async ({ device }) => {
  await device.type(id("email_input"), "bad@example.com");
  await device.type(id("password_input"), "wrong");
  await device.tap(text("Sign In"));

  await expect(device.element(text("Invalid credentials"))).toBeVisible();
});
```

### CLI

```bash
# Run all tests
npx pilot test

# Run a specific file
npx pilot test tests/login.test.ts

# Run with headed emulator (default: use whatever's connected)
npx pilot test --device emulator-5554

# Show version
npx pilot --version
```

---

## Rust Core Daemon Requirements

### Responsibilities

- Accept gRPC calls from the TypeScript SDK.
- Manage ADB connections (detect devices, forward ports, install APKs).
- Route commands to the on-device agent and return results.
- Capture screenshots via ADB `screencap` on failure.
- Start/stop cleanly. Handle unexpected device disconnection gracefully.

### Communication Protocol

Define a protobuf schema for all commands and responses between the daemon and the TypeScript SDK, and between the daemon and the on-device agent. Every command has:

- A unique request ID.
- A timeout.
- A structured response (success with result data, or failure with error type + message + optional screenshot bytes).

### Build & Distribution

- Compile to a single static binary per platform (Linux x86_64, macOS arm64, macOS x86_64, Windows x86_64).
- The `pilot` npm package downloads the correct binary on `npm install` (postinstall script).
- No runtime dependencies beyond ADB (which must already be on the user's PATH).

---

## On-Device Agent Requirements

### Implementation

- A minimal Android instrumentation APK written in Kotlin.
- Uses UIAutomator2 under the hood for element finding and interaction.
- Runs as an instrumentation test (`am instrument`) on the device.
- Opens a local TCP socket for communication with the host daemon (port forwarded via ADB).

### Capabilities

The agent must expose these operations over the socket:

- `findElement(selector)` → Returns element info (bounds, text, enabled, visible, class, id, contentDescription) or null.
- `findElements(selector)` → Returns array of matching elements.
- `tap(elementId)` / `tap(x, y)` — Tap by element or coordinates.
- `longPress(elementId, durationMs)` — Long press.
- `typeText(elementId, text)` — Focus and type.
- `clearText(elementId)` — Clear an input field.
- `swipe(startX, startY, endX, endY, durationMs)` — Perform a swipe gesture.
- `pressKey(keyCode)` — Send a key event.
- `getUiHierarchy()` — Dump the full view hierarchy (for debugging/errors).
- `waitForIdle(timeoutMs)` — Wait until the UI is idle.
- `screenshot()` — Capture the current screen as PNG bytes.

### Reliability

- The agent must recover from transient failures (app crashes, ANRs) and report them clearly rather than hanging.
- The agent must not interfere with the app's behavior. It should be read-only except when executing explicit commands.
- Connection loss between agent and daemon should be detected within 5 seconds.

---

## Project Structure

```
pilot/
├── packages/
│   ├── pilot/                   # npm package (TypeScript SDK + test runner)
│   │   ├── src/
│   │   │   ├── index.ts         # Public API exports
│   │   │   ├── device.ts        # Device interaction methods
│   │   │   ├── selectors.ts     # Selector builders (text, id, etc.)
│   │   │   ├── expect.ts        # Assertion library
│   │   │   ├── runner.ts        # Test runner (describe/it/beforeEach)
│   │   │   ├── config.ts        # Config loading
│   │   │   ├── grpc-client.ts   # gRPC client to Rust daemon
│   │   │   └── cli.ts           # CLI entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── pilot-core/              # Rust daemon
│       ├── src/
│       │   ├── main.rs
│       │   ├── adb.rs           # ADB connection management
│       │   ├── device.rs        # Device state tracking
│       │   ├── agent_comms.rs   # Communication with on-device agent
│       │   ├── grpc_server.rs   # gRPC server for TypeScript SDK
│       │   └── screenshot.rs    # Screenshot capture
│       ├── proto/
│       │   └── pilot.proto      # Protobuf definitions
│       └── Cargo.toml
│
├── agent/                       # Android on-device agent
│   ├── app/src/main/
│   │   ├── kotlin/
│   │   │   ├── PilotAgent.kt           # Entry point (instrumentation)
│   │   │   ├── SocketServer.kt         # TCP socket server
│   │   │   ├── CommandHandler.kt       # Route commands to actions
│   │   │   ├── ElementFinder.kt        # UIAutomator2 element finding
│   │   │   ├── ActionExecutor.kt       # Tap, type, swipe, etc.
│   │   │   ├── WaitEngine.kt           # Auto-wait logic (event-driven)
│   │   │   └── HierarchyDumper.kt      # View hierarchy serialization
│   │   └── AndroidManifest.xml
│   └── build.gradle.kts
│
├── proto/
│   └── pilot.proto              # Shared protobuf definitions
│
└── README.md
```

---

## Success Criteria for MVP

The MVP is done when:

1. A developer can `npm install pilot`, point it at an APK, write a test using tap/type/swipe/scroll/assertions, and run it against a connected Android device or emulator with **zero additional setup** beyond having ADB installed.
2. A suite of 20 tests covering common app flows (login, navigation, form filling, list scrolling) passes **100 out of 100 runs** with no flaky failures.
3. Failed tests produce a clear error message + screenshot showing exactly what went wrong.
4. The total time from `npx pilot test` to first test executing is under 10 seconds (excluding APK install).
5. Documentation covers: installation, writing your first test, selector guide, configuration options, and CI setup (even though CI integration isn't MVP, the docs should explain how to run in headless emulator mode).

---

## What Is NOT in MVP

These are explicitly deferred to avoid scope creep:

- iOS support
- Network interception
- Visual regression testing
- Trace viewer / recording
- Parallel device execution
- CI/CD integrations
- Webview support
- Deep link navigation helpers
- Cloud device farm integrations
- Plugin/extension system
