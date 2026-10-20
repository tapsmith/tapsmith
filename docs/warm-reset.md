# Warm App Reset

Tapsmith resets your app to a known state before tests (see [Test isolation](writing-tests.md#test-isolation)). By default that means wiping app data and cold-launching — fully hermetic, but 7–13 seconds per file on an iOS simulator and a couple of seconds on Android. A **warm reset** asks the running app to reset *itself*, in-process, and acknowledges completion — well under a second. It also makes isolating **every test** instead of every file affordable: the default is still one reset per file, and a scope opts in with `appResetScope: "test"`.

## Add the in-app hooks

Install `@tapsmith/react-native` in your app and mount it once at the root:

```bash
npm install @tapsmith/react-native
```

```tsx
// app/_layout.tsx (Expo Router) — or your root component
import * as Linking from "expo-linking"
import { Stack } from "expo-router"
import { TapsmithTestHooks } from "@tapsmith/react-native"

export default function RootLayout() {
  return (
    <>
      <Stack />
      <TapsmithTestHooks
        urlPrefix={Linking.createURL("/")}
        enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}
      />
    </>
  )
}
```

Keep the `enabled` line exactly as written, in your app's own code: it is what lets a Release build made for tests turn the hooks on (see [Release builds for e2e](#release-builds-for-e2e)).

To wipe stored data on every reset, pass the stores your app keeps it in as `clear`. With AsyncStorage (`npx expo install @react-native-async-storage/async-storage`, which the stock Expo template does not include):

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage"

<TapsmithTestHooks
  urlPrefix={Linking.createURL("/")}
  enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}
  clear={[AsyncStorage]}
/>
```

That is the whole integration. **No Tapsmith config changes**: `appReset: 'auto'` detects the hooks in the app's accessibility tree and the file-entry reset switches from clear + relaunch (5-10 s) to a warm in-app reset (~1 s). Scopes whose tests need a fresh app before *every* test opt in with `test.use({ appResetScope: 'test' })` — each of those resets is warm too. Your existing `beforeEach` resets keep working (the lint rule `tapsmith/prefer-app-reset-option` will point out the ones that are now redundant).

| Prop | Purpose |
|---|---|
| `clear` | Stores to wipe on every reset — anything with `clear()` or `clearAll()`: AsyncStorage, MMKV, … |
| `onReset` | Your own reset: sign out, drop in-memory caches, reset navigation. Receives `{ target, nonce }`. |
| `urlPrefix` / `scheme` | How Tapsmith builds reset links into your app. Expo: `Linking.createURL("/")` (works in Expo Go and standalone builds). Bare React Native: `scheme="myapp"`. |
| `enabled` | Whether the hooks are on. Pass `__DEV__ \|\| process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"`, as above. Left out, the package checks `__DEV__` and the flag itself, but Expo never inlines the flag inside `node_modules`, so an Expo Release build gets no hooks. When off, the component renders nothing and registers nothing. |

`registerTapsmithReset(fn)` registers a handler from non-React code.

### Release builds for e2e

Release builds strip `__DEV__`. Set `EXPO_PUBLIC_TAPSMITH_HOOKS=1` in the environment of the build that your tests run against (the repo's own e2e workflows do this). The `enabled` line in your root layout then turns the hooks on.

The flag has to be read in your app's code, as `enabled` above, not left to the package. Expo inlines `EXPO_PUBLIC_*` variables only in app code, never inside `node_modules`, so the package cannot see the flag in a Release build. If the app depends on `@tapsmith/react-native` but a reset still finds no hooks in the freshly relaunched app, Tapsmith adds a warning to the next test's result saying that resets are the slow kind, and names this as the likely cause. It does this once per device session, so a run with several workers can show it once per worker, and each watch-mode or MCP re-run, which starts a fresh session, shows it again.

In a bare React Native app, which does not inline `EXPO_PUBLIC_*` variables, pass `enabled` from a build-time flag of your own.

> **Warning: never ship a build with the flag to users.** With the hooks compiled in, anything that can open your app's URL scheme — another app, a webpage — can wipe its local storage and navigate it. The flag is inlined at build time, so the only guard is the build pipeline itself: set `EXPO_PUBLIC_TAPSMITH_HOOKS=1` only in the job that produces your test build, and make sure store/production release jobs never export it (a shared CI environment or `.env` file is the classic leak).


## What a warm reset does not clear

The reset clears storage and re-navigates, but React keeps component-local state that survives navigation: a `ScrollView` offset, an uncontrolled `TextInput`, an animation value. If a test relies on such state being fresh (for example, tapping a link at the top of a home list that an earlier test scrolled), reset it when the epoch changes:

```tsx
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

export default function HomeScreen() {
  const resetEpoch = useTapsmithResetEpoch()
  const listRef = useRef<ScrollView>(null)
  useEffect(() => {
    if (resetEpoch > 0) listRef.current?.scrollTo({ y: 0, animated: false })
  }, [resetEpoch])
  return <ScrollView ref={listRef}>…</ScrollView>
}
```

`useTapsmithResetEpoch()` returns the number of resets acknowledged in this process — it changes after every reset and is `0` at launch, so it costs nothing in production builds where the hooks are disabled. Prefer an imperative reset like this over remounting with `key={resetEpoch}`: on Android a remounted `ScrollView` exposes accessibility nodes with empty bounds until the next input event, which hides its items from UIAutomator.

## How a warm reset works

1. The component renders a tiny marker in the accessibility tree — `tapsmith-hooks:1;epoch=<n>;nav=<n>;boot=<token>;url=<prefix>` — that Tapsmith reads once after launch (that is the detection) and again after every reset. `nav` counts every URL the process receives, which lets Tapsmith positively acknowledge plain navigation deep links too — including a link to the screen already showing, which no UI heuristic can verify (on iOS that used to cost the full warm-delivery window plus a cold relaunch, ~11 s per navigation). `boot` is a random token generated once per app process: when Tapsmith delivers a reset cold (its periodic cold-launch valve, or a retry), the epoch counter restarts with the process, and a changed `boot` is how the fresh process's acknowledgement is recognised.
2. To reset, Tapsmith opens `<prefix><route>?__tapsmith_reset=1&nonce=…` — a normal deep link, so your router lands on `route` while the hooks clear the stores and run `onReset`.
3. The hooks bump `epoch`. Tapsmith waits for the epoch to advance — that is the **acknowledgement**; no fixed sleeps. If your handler throws, the epoch still advances and the marker carries `err=…`, so Tapsmith reports the failure and falls back instead of hanging.

The whole ladder — warm → restart → clear — runs in the daemon (`ResetApp`), and the trace records which rung ran and why: *"warm reset via @tapsmith/react-native (epoch 4→5), 0.4s"*, or *"warm reset via in-app hooks failed (…); fell back to restart"*. Two robustness details: a marker read that misses mid-transition (a busy screen, heavy trace capture) does not downgrade the reset — once hooks have been seen in a session, the daemon acknowledges against the last epoch it saw, since the epoch only advances when a reset is delivered and the `boot` token covers an unnoticed relaunch. And when a *declared* warm policy genuinely cannot run warm, it falls back to a **clear**, not a restart — the policy promised state-clearing (only the explicit `device.resetApp()` API uses the gentler restart fallback).

### Bounding the warm window on iOS simulators

Long all-warm sessions on a simulator can drift from a fresh launch (accessibility trees stop being flattened, element ids go stale). Tapsmith therefore relaunches cold every `appResetColdEvery` warm resets (default 10), on every retry attempt, and after two warm resets in a row fail to verify. The trace says so: *"cold relaunch: warm-window bound reached (10 resets)"*. Set `appResetColdEvery: 0` to disable the valve.

## Without the module

Everything still works: `appReset: 'auto'` resolves to `clear · per file`. The legacy `resetAppDeepLink` option (a route your app handles by resetting itself) also still gives you `warm · per file`, without acknowledgement — Tapsmith waits `resetAppWaitMs` after opening it.

## Calling it yourself

`device.resetApp()` runs the same ladder from inside a test and returns what actually happened:

```typescript
const result = await device.resetApp({ target: "/settings" })
// result.modeUsed === 'warm', result.hooksDetected === true, result.durationMs ≈ 400
```

See [`device.resetApp`](api-reference.md#deviceresetappoptions-promiseappresetresult).


## How this compares to other frameworks

Every mobile testing tool has to answer the same question — how does a test start from a known state? — and the answers differ mainly in where the cost and the complexity live. (Comparisons as of early 2026; check each project's current docs.)

**Maestro** resets by wiping app data at the device level (`launchApp` with `clearState: true`) — the equivalent of Tapsmith's `clear` rung, typically paid cold at the top of every flow. There is no warm concept, no in-app cooperation, and no per-test granularity below the flow; keeping suites fast means clearing less and managing test order yourself. Tapsmith without the hooks module behaves much like this (`clear · per file`, with auto-waiting); the hooks are what remove the trade-off.

**Appium** exposes reset as session-scoped capabilities — `fullReset` (uninstall + reinstall), the default reset, or `noReset` — chosen once per session. Isolation between individual tests is left to the test author via manual `terminateApp`/`activateApp`, all of it cold and unacknowledged.

**Detox** is the closest relative: `device.reloadReactNative()` reloads the JS bundle without relaunching the process, and it is fast enough to run per test. Three differences matter. A JS reload keeps persisted storage, so it corresponds to Tapsmith's `restart` rung — isolation-grade cleanup (the `clear`/`onReset` work the hooks do) remains a manual, per-suite job. Integration is gray-box: Detox links native code into your app on both platforms and is React Native-only, where `@tapsmith/react-native` is one JavaScript component over the standard UIAutomator/XCUITest channel. And synchronization differs in scope: Detox waits for the whole app to go idle (which can hang on screens that never idle — endless animations, spinners), while Tapsmith's acknowledgement answers exactly one question — *did the reset finish?* — via the marker epoch, from outside the process.

What has no counterpart elsewhere, to our knowledge, is the machinery *around* the reset: automatic detection (no config), the declared isolation policy whose satisfaction lattice lets a startup launch or a background preparation absorb a reset entirely, positive acknowledgement as a protocol (epoch, boot token, nav counter), and UI mode preparing the device before you press Run. These are deliberately Playwright's ideas mapped to mobile — `appReset` is the closest thing a device has to a fresh browser context, prepared devices are pre-warmed contexts — because a one-line `clearState: true` is simple, but paying 5–13 seconds for it before every flow is the tax this page exists to remove.
