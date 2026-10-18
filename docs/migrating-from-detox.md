# Migrating from Detox

This guide is for teams with a Detox suite who want to move it to Tapsmith. Of the mobile testing tools, Detox is the closest to Tapsmith: both are driven from JavaScript or TypeScript, both use `describe` and `expect`, and both were built with React Native in mind. The guide maps Detox's concepts onto Tapsmith's, ports one test side by side, and lists what works differently, including what Tapsmith doesn't do yet.

> Written against **Detox 20.51** and its documentation as of October 2026. Check [Detox's docs](https://wix.github.io/Detox/) for the version you run.

## The big differences

- **No native code in your app.** Detox works from inside your app: on Android through Gradle changes, a `DetoxTest` instrumentation class and a separate test APK, on iOS through a library it injects into the app process at launch. Tapsmith drives the app from outside through UIAutomator2 (Android) and XCUITest (iOS), the same way the platform's own UI tests do. It installs and tests the build you already have, React Native or not.
- **No Jest.** Tapsmith has its own runner, modelled on Playwright's: `test()`, `describe()`, hooks, fixtures, retries, projects, reporters, workers and sharding, configured in `tapsmith.config.ts`. There is no `jest.config.js`, `testRunner` block or `detox build` step.
- **Auto-waiting replaces synchronization.** Detox waits for your app to go idle (no pending network requests, timers, animations or React Native bridge work) before each action. Tapsmith doesn't watch the app's internals: it waits for the specific element an action or assertion needs, and retries assertions until they pass. A screen that never goes idle (a looping animation, a polling request) doesn't block Tapsmith.
- **Locators, not matchers.** `element(by.id("email-input"))` becomes `device.getByTestId("email-input")`, and Tapsmith encourages user-facing locators: `device.getByRole("textfield", { name: "Email" })`.

## Concept mapping

### Test structure

| Detox (Jest) | Tapsmith |
|---|---|
| `describe` / `it` | [`describe`](api-reference.md#describename-string-fn---void-void--testdescribename-fn) / [`test`](api-reference.md#testname-string-fn-fixtures-testfixtures--promisevoid-void), imported from `tapsmith` |
| Globals `device`, `element`, `by`, `expect`, `waitFor` | The `device` fixture passed to each test (`async ({ device }) => …`), and `expect` imported from `tapsmith` |
| `beforeAll` / `beforeEach` / `afterEach` / `afterAll` | The same names, imported from `tapsmith` ([Hooks](writing-tests.md#hooks)); they receive fixtures too |
| `it.only` / `it.skip` | [`test.only`](api-reference.md#testonlyname-fn) / [`test.skip`](api-reference.md#testskipname-fn) |
| `.detoxrc.js` (`apps`, `devices`, `configurations`) | [`tapsmith.config.ts`](configuration.md), with one [project](configuration.md#projects-with-per-device-targeting) per app and device pair |
| `detox build` | Your own build command; Tapsmith installs the result (`apk` / `app` in the config) |
| `detox test -c ios.sim.release` | `npx tapsmith test --project ios` |
| `detox test --retries 2` | `retries: 2` in the config (retries the failed test, not the whole file) |
| `--take-screenshots failing` | `screenshot: "only-on-failure"` (the default) |
| `--record-videos failing` | `video: "retain-on-failure"` ([Video recording](api-reference.md#video-recording)) |
| `--record-logs failing` | `trace: "retain-on-failure"`: a [trace](trace-viewer.md) with a screenshot, the view hierarchy and the network traffic for every action |
| Jest's `--maxWorkers` | [`workers`](parallel-and-sharding.md) / `--workers N` |

### Matchers to locators

| Detox | Tapsmith |
|---|---|
| `element(by.id("submit"))` | [`device.getByTestId("submit")`](api-reference.md#devicegetbytestidtestid-string-elementhandle) |
| `element(by.text("Sign in"))` | [`device.getByText("Sign in", { exact: true })`](api-reference.md#devicegetbytexttext-string--regexp-options--exact-boolean--elementhandle) (without `exact`, a substring match) |
| `element(by.label("Close"))` | [`device.getByDescription("Close")`](api-reference.md#devicegetbydescriptiontext-string-elementhandle), or `getByRole(role, { name: "Close" })` |
| `element(by.traits(["button"]))` (iOS) | [`device.getByRole("button")`](api-reference.md#devicegetbyrolerole-string-options-elementhandle), on both platforms |
| `element(by.type("RCTTextInput"))` | [`device.locator({ className: … })`](api-reference.md#devicelocatoroptions-locatoroptions-elementhandle) (native class names differ per platform) |
| `by.id("row").withDescendant(by.text("Premium"))` | [`device.getByTestId("row").filter({ has: device.getByText("Premium", { exact: true }) })`](api-reference.md#elementhandlefiltercriteria-filteroptions-elementhandle) |
| `by.text("Delete").withAncestor(by.id("row-5"))` | [`device.getByTestId("row-5").getByText("Delete", { exact: true })`](api-reference.md#scoping) (scoping) |
| `by.id("a").and(by.text("b"))` | [`device.getByTestId("a").and(device.getByText("b"))`](api-reference.md#elementhandleandother-elementhandle-elementhandle) |
| `.atIndex(2)` | [`.nth(2)`](api-reference.md#elementhandlenthindex-number-elementhandle), `.first()`, `.last()` |
| `element(…).getAttributes()` | [`locator.find()`](api-reference.md#elementhandlefind-promiseelementinfo), or `getText()`, `isEnabled()`, `boundingBox()`, … |

### Actions

| Detox | Tapsmith |
|---|---|
| `.tap()` | [`.tap()`](api-reference.md#elementhandletap-promisevoid) |
| `.multiTap(2)` | [`.doubleTap()`](api-reference.md#elementhandledoubletapoptions--intervalms-number--promisevoid) |
| `.longPress(1500)` | [`.longPress(1500)`](api-reference.md#elementhandlelongpressdurationms-number-promisevoid) |
| `.typeText("hi")` | [`.type("hi")`](api-reference.md#elementhandletypetext-string-options--delay-number--promisevoid), into an empty field (into a field that already has text, `type()` replaces it on Android and adds to it on iOS) |
| `.replaceText("hi")` | [`.clearAndType("hi")`](api-reference.md#elementhandleclearandtypetext-string-options--delay-number--promisevoid) (types it, so your `onChangeText` handlers run) |
| `.clearText()` | [`.clear()`](api-reference.md#elementhandleclear-promisevoid) |
| `.tapReturnKey()` | [`device.pressKey("ENTER")`](api-reference.md#devicepresskeykey-string-promisevoid) |
| `.scroll(200, "down")` | [`.scroll("down")`](api-reference.md#elementhandlescrolldirection-string-options--distance-number--promisevoid) scrolls the view by a step of its own size (no offset in points); to reach an element, prefer `scrollIntoView()` |
| `waitFor(el).toBeVisible().whileElement(by.id("list")).scroll(50, "down")` | [`el.scrollIntoView()`](api-reference.md#elementhandlescrollintoviewoptions--direction-string-maxscrolls-number-speed-number--promisevoid) |
| `.swipe("up")` | [`device.swipe("up")`](api-reference.md#deviceswipedirection-string-options-swipeoptions-promisevoid) |
| `.pinch(0.5)` (iOS) | [`.pinchIn()`](api-reference.md#elementhandlepinchinoptions--scale-number--promisevoid) / [`.pinchOut()`](api-reference.md#elementhandlepinchoutoptions--scale-number--promisevoid), on both platforms |

### Expectations to assertions

| Detox | Tapsmith |
|---|---|
| `await expect(el).toBeVisible()` | [`await expect(el).toBeVisible()`](api-reference.md#tobevisibleoptions-promisevoid) (Detox's default is 75% on screen; use [`toBeInViewport({ ratio: 0.75 })`](api-reference.md#tobeinviewportoptions-promisevoid) for a share of the element) |
| `.not.toBeVisible()` / `.not.toExist()` | `.not.toBeVisible()` or [`.toBeHidden()`](api-reference.md#tobehiddenoptions-promisevoid) / `.not.toExist()` |
| `.toExist()` | [`.toExist()`](api-reference.md#toexistoptions-promisevoid) |
| `.toBeFocused()` | [`.toBeFocused()`](api-reference.md#tobefocusedoptions-promisevoid) |
| `.toHaveText("Hi")` | [`.toHaveText("Hi")`](api-reference.md#tohavetextexpected-string--regexp--arraystring--regexp-options-promisevoid) |
| `.toHaveLabel("Close")` | [`.toHaveAccessibleName("Close")`](api-reference.md#tohaveaccessiblenamename-string--regexp-options-promisevoid) |
| `.toHaveToggleValue(true)` | [`.toBeChecked()`](api-reference.md#tobecheckedoptions-promisevoid) |
| `.toHaveValue("…")` (the accessibility value) | [`.toHaveValue("…")`](api-reference.md#tohavevaluevalue-string-options-promisevoid) checks a text field's contents, not the accessibility value |
| `waitFor(el).toBeVisible().withTimeout(10000)` | `await expect(el).toBeVisible({ timeout: 10_000 })`, or [`el.waitFor({ timeout: 10_000 })`](api-reference.md#elementhandlewaitforoptions-promisevoid) |

### The `device` object

| Detox | Tapsmith |
|---|---|
| `device.launchApp()` | Automatic before each test file; [`device.launchApp(pkg)`](api-reference.md#devicelaunchapppackagename-string-options-launchappoptions-promisevoid) mid-test |
| `device.launchApp({ newInstance: true })` | [`device.restartApp(pkg)`](api-reference.md#devicerestartapppackagename-string-options--waitforidle-boolean--promisevoid), or `appReset: "restart"` |
| `device.launchApp({ delete: true })` | The default `appReset` policy (clear data and relaunch; a warm, in-app reset instead when the app mounts `@tapsmith/react-native`), or [`device.resetApp({ mode: "clear" })`](api-reference.md#deviceresetappoptions-promiseappresetresult) |
| `device.launchApp({ url })` / `device.openURL({ url })` | [`device.openDeepLink(url)`](api-reference.md#deviceopendeeplinkuri-string-options-opendeeplinkoptions-promisevoid) |
| `device.launchApp({ permissions })` (iOS) | On a simulator, [`device.grantPermission(bundleId, "photos")`](api-reference.md#devicegrantpermissionpackagename-string-permission-string-promisevoid) for each service `simctl privacy` supports (not notifications); some changes make iOS terminate the app, which Tapsmith does not relaunch for you |
| `device.reloadReactNative()` | A warm reset through [`@tapsmith/react-native`](warm-reset.md), automatic between files once the app mounts it |
| `device.terminateApp()` | [`device.terminateApp()`](api-reference.md#deviceterminateapppackagename-string-promisevoid) |
| `device.sendToHome()` | [`device.sendToBackground()`](api-reference.md#devicesendtobackground-promisevoid) |
| `device.pressBack()` | [`device.pressBack()`](api-reference.md#devicepressback-promisevoid-android-only) |
| `device.setOrientation("landscape")` | [`device.setOrientation("landscape")`](api-reference.md#devicesetorientationorientation-orientation-promisevoid) |
| `device.takeScreenshot(name)` | [`device.takeScreenshot()`](api-reference.md#devicetakescreenshot-promisescreenshotresponse) |
| `device.getPlatform()` | [`device.platform`](api-reference.md#deviceplatform-android--ios), or the `platform` fixture |
| `device.disableSynchronization()` | Not needed: there is no app-wide synchronization to turn off |

## Porting a test

The sign-in screen of the React Native test app in the Tapsmith repository, tested with Detox:

```javascript
// e2e/login.test.js
describe("Login", () => {
  beforeEach(async () => {
    await device.launchApp({ newInstance: true, delete: true, url: "tapsmithtest:///login" });
  });

  it("signs in with valid credentials", async () => {
    await element(by.id("email-input")).typeText("test@example.com");
    await element(by.id("password-input")).typeText("password123");
    await element(by.id("password-input")).tapReturnKey();
    await element(by.label("Sign in")).tap();
    await expect(element(by.id("success-message"))).toBeVisible();
  });

  it("rejects a wrong password", async () => {
    await element(by.id("email-input")).typeText("test@example.com");
    await element(by.id("password-input")).typeText("wrong");
    await element(by.id("password-input")).tapReturnKey();
    await element(by.label("Sign in")).tap();
    await expect(element(by.text("Invalid credentials"))).toBeVisible();
  });
});
```

The same tests in Tapsmith:

```typescript
// tests/login.tapsmith.ts
import { test, describe, expect } from "tapsmith";

describe("Login", () => {
  // Detox's `launchApp({ delete: true })` before every test: a fresh app before each test.
  test.use({ appResetScope: "test" });

  test.beforeEach(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///login");
  });

  test("signs in with valid credentials", async ({ device }) => {
    await device.getByTestId("email-input").type("test@example.com");
    await device.getByTestId("password-input").type("password123");
    await device.hideKeyboard();
    await device.getByRole("button", { name: "Sign in" }).tap();
    await expect(device.getByTestId("success-message")).toBeVisible();
  });

  test("rejects a wrong password", async ({ device }) => {
    await device.getByTestId("email-input").type("test@example.com");
    await device.getByTestId("password-input").type("wrong");
    await device.hideKeyboard();
    await device.getByRole("button", { name: "Sign in" }).tap();
    await expect(device.getByText("Invalid credentials", { exact: true })).toBeVisible();
  });
});
```

The `.detoxrc.js` that pointed Detox at the builds becomes a `tapsmith.config.ts` with a project per platform:

```javascript
// .detoxrc.js (abridged)
module.exports = {
  testRunner: { args: { $0: "jest", config: "e2e/jest.config.js" } },
  apps: {
    "android.release": {
      type: "android.apk",
      binaryPath: "android/app/build/outputs/apk/release/app-release.apk",
      build: "cd android && ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release",
    },
    "ios.release": {
      type: "ios.app",
      binaryPath: "ios/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
      build: "xcodebuild -workspace ios/TapsmithTestApp.xcworkspace -scheme TapsmithTestApp -configuration Release -sdk iphonesimulator -derivedDataPath ios/build",
    },
  },
  devices: {
    emulator: { type: "android.emulator", device: { avdName: "Pixel_7_API_35" } },
    simulator: { type: "ios.simulator", device: { type: "iPhone 16" } },
  },
  configurations: {
    "android.emu.release": { device: "emulator", app: "android.release" },
    "ios.sim.release": { device: "simulator", app: "ios.release" },
  },
};
```

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
  package: "dev.tapsmith.testapp",
  projects: [
    {
      name: "android",
      use: {
        platform: "android",
        apk: "./android/app/build/outputs/apk/release/app-release.apk",
        avd: "Pixel_7_API_35",
        launchEmulators: true,
      },
    },
    {
      name: "ios",
      use: {
        platform: "ios",
        app: "./ios/build/Build/Products/Release-iphonesimulator/TapsmithTestApp.app",
        simulator: "iPhone 16",
      },
    },
  ],
});
```

What changed:

- **Globals became fixtures and imports.** `device` arrives as an argument to each test and hook, and `test`, `describe` and `expect` are imported from `tapsmith`. Everything is typed.
- **The reset moved into configuration.** Instead of a `launchApp` in `beforeEach`, `test.use({ appResetScope: "test" })` asks for a fresh app before every test. Without it, Tapsmith resets once per test file. The deep link that opens the screen stays in `beforeEach`.
- **Matchers became locators.** `by.id` maps straight onto `getByTestId`, which matches a React Native `testID` on both platforms. The button is found by role and accessible name. Where a locator matches several elements, Tapsmith's [strict mode](api-reference.md#strict-mode) throws and lists the matches instead of picking one, so use `.nth()` or a narrower locator where Detox needed `.atIndex()`.
- **`tapReturnKey()` became `device.hideKeyboard()`**, which dismisses the keyboard without submitting the field where it can (on iOS its last resort, when nothing else puts the keyboard away, is the return key of a single-line field, which does submit it). `device.pressKey("ENTER")` is still there if you want to submit.
- **The build is yours.** `detox build` ran the `build` command from `.detoxrc.js`; with Tapsmith you run that command yourself (in CI, as a step before `npx tapsmith test`), and you build your normal app. The `assembleAndroidTest` APK and the Detox Gradle and `DetoxTest` setup are no longer needed.

Run one platform with `npx tapsmith test --project android`, or both with `npx tapsmith test`.

## Setup and configuration

| Detox | Tapsmith |
|---|---|
| `npm install -D detox jest`, `detox init`, native Android setup | `npm install -D tapsmith`, then [`npx tapsmith init`](getting-started.md#quick-setup-recommended) |
| `applesimutils` (iOS) | Nothing extra: Xcode's `simctl` is enough (it grants fewer permissions than `applesimutils`; see below). `npx tapsmith doctor` checks the setup |
| `devices.*.device.avdName` | `avd` (Tapsmith launches it when it isn't running) |
| `devices.*.device.type` (simulator) | `simulator` |
| `apps.*.binaryPath` | `apk` (Android) or `app` with `platform: "ios"` |
| `configurations.*` | [`projects`](configuration.md#projects-with-per-device-targeting), selected with `--project` |
| `detox test --headless` | Emulators Tapsmith launches run headless in CI automatically, and locally with `emulatorLaunchOptions: { headless: true }` ([How Tapsmith launches emulators](configuration.md#how-tapsmith-launches-emulators)) |
| `--reuse` | The default: Tapsmith installs the app when the build changed |
| `detox test e2e/login.test.js` | `npx tapsmith test tests/login.tapsmith.ts` |
| `--retries` | `retries` in the config, `test.use()` or `test.describe.configure()` |
| Jest's `--maxWorkers 3` | `workers: 3` or `--workers 3`, one device per worker ([Parallel execution](parallel-and-sharding.md)) |
| Jest's `--shard` | `npx tapsmith test --shard=1/4` and `npx tapsmith merge-reports` ([CI sharding](parallel-and-sharding.md#ci-sharding)) |
| Jest reporters (`jest-junit`, …) | Built-in `junit`, `html`, `json`, `github` and `blob` [reporters](api-reference.md#reporters) |

For CI, the [CI setup guide](ci-setup.md) has complete GitHub Actions workflows for Android and iOS.

Name Tapsmith test files `*.tapsmith.ts` (what `tapsmith init` sets up), so that your Jest unit tests never pick them up ([why](getting-started.md#tapsmith-tests-and-your-unit-tests)).

## What works differently

**Waiting.** Detox's synchronization means most Detox tests have no explicit waits, and you only reach for `waitFor()` when synchronization can't see the work (or has been turned off). Tapsmith gets the same effect differently: each action waits for its element to appear, and a tap also waits for it to be enabled and not covered by something else (the keyboard, a sheet, another view); each `expect()` on an element keeps checking until it passes. Both wait up to the `timeout` in your config (30 s by default). Some consequences:

- You can delete `device.disableSynchronization()`, `setURLBlacklist()` and the waits around screens with endless animations or long-polling: Tapsmith doesn't wait for the app to go idle, so those screens are not a problem.
- `waitFor(...).withTimeout(ms)` becomes the assertion with `{ timeout: ms }`.
- An assertion that something is absent (`not.toBeVisible()`, `toBeHidden()`) waits for it to go away, rather than checking once.

**Resetting the app.** Detox suites reset with `device.launchApp({ delete: true })` (reinstall), `newInstance: true` (relaunch), or `device.reloadReactNative()` (reload the JavaScript, keeping the process and its storage). In Tapsmith the reset is a declared policy, `appReset`, rather than a call in a hook:

- By default the app's data is cleared and the app relaunched once per test file. The tests in a file share the app, so add `test.use({ appResetScope: "test" })` where each test needs a fresh one.
- React Native apps that mount [`@tapsmith/react-native`](warm-reset.md) get a **warm** reset: the hooks clear the stores you list (AsyncStorage, for example), navigate to a route and confirm the reset finished, in-process, in about a second. Unlike `reloadReactNative()`, it clears persisted state. A release build needs the hooks switched on at build time ([Release builds for e2e](warm-reset.md#release-builds-for-e2e)); without that, every reset is a clear and relaunch.
- To start tests already signed in, sign in once in a setup project and restore the saved app state ([Authentication patterns](writing-tests.md#authentication-patterns)).

**Grouping steps.** Tapsmith's test API follows Playwright's, but Playwright's `test.step()` isn't there yet. To group actions under a name in the trace, use `device.tracing.group(name)` and `device.tracing.groupEnd()` ([other Playwright APIs not supported yet](api-reference.md#playwright-apis-not-supported-yet)).

**Counting list rows.** A locator counts what the platform's accessibility tree holds, and for a long, scrolling list the platforms differ: on Android the tree usually holds just the rows on screen, while on iOS it can also hold rows the list has already rendered off screen. So `count()` and `toHaveCount()` on such a list can give a different number on each platform. Assert on the rows you care about instead (bring one into view with `scrollIntoView()`), or count a list that fits on screen.

**Mocking.** Detox suites often mock modules at build time (an `.e2e.js` file extension picked up by Metro) or block URLs. Tapsmith doesn't change your bundle. To mock or inspect HTTP traffic, use [`device.route()`](network.md), Playwright's network interception for the device. Build-time module mocks still work if you keep building with them; Tapsmith tests whatever build you give it.

**Locators.** Detox's `by.id` and `by.text` keep working as `getByTestId` and `getByText`, so a first port can be mechanical. Over time, prefer `getByRole` with a name: it checks what the element is as well as its label, and pushes the app towards being accessible ([Locators](locators.md)). Two details to watch for: `getByText("Sign in")` without `{ exact: true }` matches any text containing "Sign in", and an ambiguous locator throws rather than acting on the first match.

**Debugging.** Detox's artifacts (screenshots, videos, logs) map to Tapsmith's `screenshot`, `video` and `trace` options. A trace records every action with a screenshot, the view hierarchy and the network traffic, and opens with [`npx tapsmith show-trace`](trace-viewer.md). For writing tests, [UI mode](ui-mode.md) (`npx tapsmith test --ui`) shows a live, clickable device mirror with a locator picker, and [watch mode](watch-mode.md) re-runs a file on save on a device session that stays up: only the app reset runs again, not the daemon, agent and install.

### Not supported yet

Some Detox device APIs have no Tapsmith equivalent at the moment:

- **Device simulation:** `setLocation`, `setBiometricEnrollment` / `matchFace` / `matchFinger`, `shake`, `setStatusBar`, and `sendUserNotification`.
- **Launch configuration:** `launchArgs` and `languageAndLocale` on `launchApp`. Tapsmith launches the app without extra arguments.
- **Some iOS permissions:** on an iOS simulator, `grantPermission()` and `revokePermission()` cover the services `xcrun simctl privacy` supports (photos, location, contacts, calendar, microphone, camera, …), which leaves out notifications, among others. On physical iOS devices they are not supported at all.
- **Jest features:** `jest.fn()` mocks, snapshot matchers and Jest's custom matchers aren't part of Tapsmith's `expect`, and Jest's watch mode is replaced by [Tapsmith's](watch-mode.md).
- **Some actions:** `scroll()` by an offset in points, `scrollTo("bottom")` (scroll to an edge; use `scrollIntoView()` on the element you want, or `scroll()` repeatedly) and setting picker wheel columns (`setColumnToValue`).

## Migrating incrementally

Detox and Tapsmith can test the same app from the same repository while you move over:

1. **Keep the two suites apart.** Leave Detox in `e2e/` with its Jest config, and put Tapsmith tests in their own folder (`tests/`) with names ending in `.tapsmith.ts`, so neither runner picks up the other's files. Run them as separate CI jobs, and never against the same device at once.
2. **Build once, test twice.** A release build of your app works for both. Tapsmith installs the same app build Detox tests and ignores Detox's Android test APK, so one build can serve both suites until Detox is gone.
3. **Port the flakiest tests first**, especially the ones that fight synchronization (`disableSynchronization()`, long `waitFor` timeouts). They tend to get simpler.
4. **Port helpers before tests.** A Detox helper module (`loginAs(user)`) becomes a [screen object](writing-tests.md#screen-object-pattern) or a [custom fixture](writing-tests.md#custom-fixtures-with-testextend) that every ported test reuses.
5. **Retire Detox when the last test is ported.** Remove the Detox Gradle setup, the `DetoxTest` class, `.detoxrc.js` and the `jest` config for e2e, and stop building the Android test APK.

See also: [Getting started](getting-started.md), [Writing tests](writing-tests.md), [Warm app reset](warm-reset.md), [API reference](api-reference.md).
