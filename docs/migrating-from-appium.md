# Migrating from Appium

This guide is for teams with an Appium suite who want to move it to Tapsmith. It maps Appium's concepts onto Tapsmith's, ports one test side by side, and lists what works differently, including what Tapsmith doesn't do yet.

Appium has clients in many languages. The examples here use [WebdriverIO](https://webdriver.io), the most common JavaScript client; the WebDriver commands behind them are the same in the Java, Python, Ruby and .NET clients.

> Written against **Appium 3.8**, the **UiAutomator2 driver 8.7** and **XCUITest driver 12.16**, and **WebdriverIO 10**, and their documentation as of October 2026. Check [Appium's docs](https://appium.io/docs/en/latest/) for the versions you run.

## The big differences

- **No server to run.** Appium is a WebDriver server: you install it and its drivers, start it, and your tests talk to it over HTTP through a client library. Tapsmith is one npm package. Its test runner starts a local daemon for you, which installs an agent on the device: UIAutomator2 on Android and XCUITest on iOS, the same frameworks Appium's main drivers use underneath.
- **No sessions or capabilities.** A capabilities object (`platformName`, `appium:app`, `appium:udid`, `appium:noReset`, …) describes each Appium session. Tapsmith reads the same information from `tapsmith.config.ts`, once for the whole suite, with a [project](configuration.md#projects-with-per-device-targeting) per device or platform.
- **Auto-waiting replaces explicit waits.** Appium finds an element when asked (WebdriverIO first waits for it to exist), and the test adds explicit waits (`waitForDisplayed`, `WebDriverWait`) wherever the app is slow. In Tapsmith every action waits for its element, and every assertion retries until it passes.
- **Role and text locators replace XPath.** Instead of XPath or platform-specific accessibility ids, Tapsmith locators describe what the user sees: `device.getByRole("button", { name: "Sign in" })` works on Android and iOS alike.
- **A test runner is included.** Tapsmith has Playwright's runner shape: `test()`, `describe()`, hooks, fixtures, retries, reporters, workers and sharding. You don't need Mocha, Jest, TestNG or pytest alongside it.

## Concept mapping

### Sessions, capabilities and the server

| Appium | Tapsmith |
|---|---|
| Appium server (`appium`) and drivers (`appium driver install uiautomator2`) | Nothing to run: `npm install -D tapsmith` brings the daemon and the device agents |
| Client library (WebdriverIO, Java client, …) | The `tapsmith` package: tests are TypeScript |
| Session (`driver`) | The [`device` fixture](api-reference.md#testfixtures) passed to each test |
| `platformName` | [`platform`](configuration.md#all-options) (`"android"` or `"ios"`) |
| `appium:automationName` | Not needed: UIAutomator2 on Android, XCUITest on iOS |
| `appium:app` | `apk` (Android) or `app` (iOS) |
| `appium:appPackage` / `appium:bundleId` | `package` |
| `appium:appActivity` | `activity` (optional) |
| `appium:udid` / `appium:deviceName` | `device` (serial or UDID), `simulator` (iOS simulator name), or `avd` (an emulator to launch) |
| `appium:noReset`, `appium:fullReset` | The [`appReset`](writing-tests.md#test-isolation) policy |
| `appium:autoGrantPermissions` | [`device.grantPermission()`](api-reference.md#devicegrantpermissionpackagename-string-permission-string-promisevoid) for each permission |
| Implicit wait (`timeouts: { implicit }`) | [`timeout`](configuration.md#all-options) (30 s by default) for every action and assertion |
| `appium:newCommandTimeout` | Not needed: there is no server session to keep alive between commands |
| Appium Inspector | [UI mode](ui-mode.md) (`npx tapsmith test --ui`): a live device mirror with a locator picker, beside your tests |
| `driver.getPageSource()` | The Hierarchy tab of the [trace viewer](trace-viewer.md) or UI mode, or the [`tapsmith_snapshot`](mcp-server.md#tapsmith_snapshot) MCP tool |

### Finding elements

| Appium (WebdriverIO) | Tapsmith |
|---|---|
| `$("~Sign in")` (accessibility id) | [`device.getByRole("button", { name: "Sign in" })`](api-reference.md#devicegetbyrolerole-string-options-elementhandle), or [`device.getByDescription("Sign in")`](api-reference.md#devicegetbydescriptiontext-string-elementhandle) |
| `$("id=com.example:id/submit")` (resource id) | [`device.locator({ id: "com.example:id/submit" })`](api-reference.md#devicelocatoroptions-locatoroptions-elementhandle); a React Native `testID` is [`device.getByTestId("submit")`](api-reference.md#devicegetbytestidtestid-string-elementhandle) |
| `$('//*[@text="Welcome"]')` (XPath) | [`device.getByText("Welcome", { exact: true })`](api-reference.md#devicegetbytexttext-string--regexp-options--exact-boolean--elementhandle) |
| `$('android=new UiSelector().textContains("Wel")')` | `device.getByText("Wel")` (substring by default) |
| `$("-ios predicate string:label == 'Done'")` | `device.getByText("Done", { exact: true })`, or `getByRole(role, { name: "Done", exact: true })` |
| `$("android.widget.Switch")` (class name) | [`device.getByRole("switch")`](api-reference.md#devicegetbyrolerole-string-options-elementhandle), or `device.locator({ className: "android.widget.Switch" })` |
| `$$(selector)` | [`locator.all()`](api-reference.md#elementhandleall-promiseelementhandle) or [`locator.count()`](api-reference.md#elementhandlecount-promisenumber) |
| `$$(selector)[2]` | [`locator.nth(2)`](api-reference.md#elementhandlenthindex-number-elementhandle) |
| `parent.$(child)` | [`parent.getByText(…)`](api-reference.md#scoping) and the other `getBy*` methods (scoping) |
| `$("//android.widget.Button[2]")` | `device.locator({ xpath: … })` still works on Android, but prefer a role or text locator |

### Actions and waits

| Appium (WebdriverIO) | Tapsmith |
|---|---|
| `el.click()` | [`locator.tap()`](api-reference.md#elementhandletap-promisevoid) |
| `el.setValue("hi")` | [`locator.clearAndType("hi")`](api-reference.md#elementhandleclearandtypetext-string-options--delay-number--promisevoid) |
| `el.addValue("hi")` | [`locator.type("hi")`](api-reference.md#elementhandletypetext-string-options--delay-number--promisevoid) (into a field that already has text, `type()` replaces it on Android and adds to it on iOS) |
| `el.clearValue()` | [`locator.clear()`](api-reference.md#elementhandleclear-promisevoid) |
| `el.getText()` | [`locator.getText()`](api-reference.md#elementhandlegettext-promisestring), or assert with [`expect(locator).toHaveText()`](api-reference.md#tohavetextexpected-string--regexp--arraystring--regexp-options-promisevoid) |
| `el.isDisplayed()` | [`locator.isVisible()`](api-reference.md#elementhandleisvisible-promiseboolean) |
| `el.waitForDisplayed({ timeout })` | [`await expect(locator).toBeVisible({ timeout })`](api-reference.md#tobevisibleoptions-promisevoid), or [`locator.waitFor()`](api-reference.md#elementhandlewaitforoptions-promisevoid) |
| `el.waitForDisplayed({ reverse: true })` | `await expect(locator).toBeHidden()` |
| `el.waitForEnabled()` | `await expect(locator).toBeEnabled()`, or nothing: `tap()` already waits for the element to be enabled |
| `driver.pause(2000)` | Nothing: delete it |
| `mobile: scroll` / `mobile: scrollGesture` / UiScrollable | [`locator.scrollIntoView()`](api-reference.md#elementhandlescrollintoviewoptions--direction-string-maxscrolls-number-speed-number--promisevoid), or [`locator.scroll()`](api-reference.md#elementhandlescrolldirection-string-options--distance-number--promisevoid) on a scroll view |
| `mobile: swipeGesture`, W3C actions | [`device.swipe()`](api-reference.md#deviceswipedirection-string-options-swipeoptions-promisevoid), [`locator.dragTo()`](api-reference.md#elementhandledragtotarget-elementhandle-promisevoid), [`device.dragXY()`](api-reference.md#devicedragxyfrom--x-number-y-number--to--x-number-y-number--options--duration-number--promisevoid) |
| `mobile: longClickGesture` / `mobile: doubleClickGesture` | [`locator.longPress()`](api-reference.md#elementhandlelongpressdurationms-number-promisevoid) / [`locator.doubleTap()`](api-reference.md#elementhandledoubletapoptions--intervalms-number--promisevoid) |
| `mobile: pinchOpenGesture` / `mobile: pinchCloseGesture` | [`locator.pinchOut()`](api-reference.md#elementhandlepinchoutoptions--scale-number--promisevoid) / [`locator.pinchIn()`](api-reference.md#elementhandlepinchinoptions--scale-number--promisevoid) |
| Tap at coordinates (W3C actions) | [`device.tapXY(x, y)`](api-reference.md#devicetapxyx-number-y-number-promisevoid) |
| `mobile: hideKeyboard` | [`device.hideKeyboard()`](api-reference.md#devicehidekeyboard-promisevoid) |
| `mobile: pressKey` / `driver.back()` | [`device.pressKey()`](api-reference.md#devicepresskeykey-string-promisevoid) / [`device.pressBack()`](api-reference.md#devicepressback-promisevoid-android-only) (Android) |

### App and device management

| Appium | Tapsmith |
|---|---|
| `mobile: activateApp` / `mobile: launchApp` | Automatic before each test file; [`device.launchApp(pkg)`](api-reference.md#devicelaunchapppackagename-string-options-launchappoptions-promisevoid) or [`device.bringToForeground(pkg)`](api-reference.md#devicebringtoforegroundpackagename-string-promisevoid) mid-test |
| `mobile: terminateApp` | [`device.terminateApp(pkg)`](api-reference.md#deviceterminateapppackagename-string-promisevoid) |
| `mobile: clearApp` | [`device.clearAppData(pkg)`](api-reference.md#deviceclearappdatapackagename-string-promisevoid), or [`device.resetApp({ mode: "clear" })`](api-reference.md#deviceresetappoptions-promiseappresetresult) |
| `mobile: installApp` | Automatic from `apk` / `app` in the config |
| `mobile: queryAppState` | [`device.getAppState(pkg)`](api-reference.md#devicegetappstatepackagename-string-promiseappstate) |
| `mobile: backgroundApp` | [`device.sendToBackground()`](api-reference.md#devicesendtobackground-promisevoid) |
| `mobile: deepLink` / `driver.url()` | [`device.openDeepLink(url)`](api-reference.md#deviceopendeeplinkuri-string-options-opendeeplinkoptions-promisevoid) |
| `driver.setOrientation()` | [`device.setOrientation()`](api-reference.md#devicesetorientationorientation-orientation-promisevoid) |
| `mobile: setClipboard` / `mobile: getClipboard` | [`device.setClipboard()`](api-reference.md#devicesetclipboardtext-string-promisevoid) / [`device.getClipboard()`](api-reference.md#devicegetclipboard-promisestring) (on a physical iPhone, see the limits in [iOS physical devices](ios-physical-devices.md)) |
| `mobile: changePermissions` | [`device.grantPermission()`](api-reference.md#devicegrantpermissionpackagename-string-permission-string-promisevoid) / `revokePermission()` (Android, and iOS simulators) |
| `driver.takeScreenshot()` | [`device.takeScreenshot()`](api-reference.md#devicetakescreenshot-promisescreenshotresponse); failures are captured automatically |
| `driver.startRecordingScreen()` | The [`video`](api-reference.md#video-recording) option, or a [trace](trace-viewer.md) |
| `driver.getContexts()` / `driver.switchContext("WEBVIEW_…")` | [`device.webview()`](api-reference.md#devicewebviewpackagename-string-promisewebviewhandle) / [`device.native()`](api-reference.md#devicenative-promisevoid) ([WebView testing](webview.md)) |

## Porting a test

The sign-in screen of the React Native test app in the Tapsmith repository, tested on Android with WebdriverIO and Appium's UiAutomator2 driver:

```javascript
// wdio.conf.js (abridged)
export const config = {
  runner: "local",
  specs: ["./test/specs/**/*.js"],
  services: ["appium"],
  framework: "mocha",
  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Android Emulator",
      "appium:app": "./android/app/build/outputs/apk/release/app-release.apk",
      "appium:appPackage": "dev.tapsmith.testapp",
      "appium:appActivity": ".MainActivity",
    },
  ],
};
```

```javascript
// test/specs/login.e2e.js
const APP = "dev.tapsmith.testapp";

describe("Login", () => {
  beforeEach(async () => {
    // A fresh app for every test: stop it, clear its data, open the screen.
    await driver.execute("mobile: terminateApp", { appId: APP });
    await driver.execute("mobile: clearApp", { appId: APP });
    await driver.execute("mobile: deepLink", { url: "tapsmithtest:///login", package: APP });
  });

  it("signs in with valid credentials", async () => {
    const email = await $("~Email");
    await email.waitForDisplayed({ timeout: 10000 });
    await email.setValue("test@example.com");
    await $("~Password").setValue("password123");
    await driver.execute("mobile: hideKeyboard");
    await $("~Sign in").click();
    await $('//*[@text="Login successful!"]').waitForDisplayed({ timeout: 10000 });
  });

  it("rejects a wrong password", async () => {
    const email = await $("~Email");
    await email.waitForDisplayed({ timeout: 10000 });
    await email.setValue("test@example.com");
    await $("~Password").setValue("wrong");
    await driver.execute("mobile: hideKeyboard");
    await $("~Sign in").click();
    await $('//*[@text="Invalid credentials"]').waitForDisplayed({ timeout: 10000 });
  });
});
```

The same tests in Tapsmith:

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  package: "dev.tapsmith.testapp",
});
```

```typescript
// tests/login.tapsmith.ts
import { test, describe, expect } from "tapsmith";

describe("Login", () => {
  // terminateApp + clearApp before every test: a fresh app before each test.
  test.use({ appResetScope: "test" });

  test.beforeEach(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///login");
  });

  test("signs in with valid credentials", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("test@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("password123");
    await device.hideKeyboard();
    await device.getByRole("button", { name: "Sign in" }).tap();
    await expect(device.getByText("Login successful!", { exact: true })).toBeVisible();
  });

  test("rejects a wrong password", async ({ device }) => {
    await device.getByRole("textfield", { name: "Email" }).type("test@example.com");
    await device.getByRole("textfield", { name: "Password" }).type("wrong");
    await device.hideKeyboard();
    await device.getByRole("button", { name: "Sign in" }).tap();
    await expect(device.getByText("Invalid credentials", { exact: true })).toBeVisible();
  });
});
```

What changed:

- **The capabilities became config.** `appium:app`, `appium:appPackage` and `appium:appActivity` are `apk`, `package` and (optionally) `activity`. There's no `automationName`, `deviceName` or Appium service: Tapsmith uses the one emulator or device it finds, or the one you name with `device`, `avd` or `--device`.
- **The reset became a declared policy.** The `terminateApp` and `clearApp` calls in `beforeEach` are what `test.use({ appResetScope: "test" })` does, including relaunching the app and waiting for it to come up; the deep link to the screen stays in `beforeEach`. Without that line, Tapsmith resets the app once per test file.
- **The explicit waits are gone.** `type()` and `tap()` wait for their element, and `expect(...).toBeVisible()` retries until the text appears. Each waits up to the config's `timeout`.
- **The locators work on iOS too.** `~Email` is an accessibility id, which Appium matches against `content-desc` on Android but against the element's name (its accessibility identifier, if it has one) on iOS, so on this screen, where the field's `testID` (`email-input`) differs from its label, `~Email` finds nothing on iOS and each platform needs its own selector. `getByRole("textfield", { name: "Email" })` matches the field's role and accessible name on both platforms, and the XPath for the success message became `getByText`. To run on iOS, add `platform: "ios"`, `app` and `simulator` (or a second [project](configuration.md#projects-with-per-device-targeting)); the test itself doesn't change.
- **`setValue` became `type`.** `type()` taps the field and types into it. Use `clearAndType()` where the field may already contain text, as `setValue` cleared it: `type()` replaces existing text on Android but adds to it on iOS.

Run it with:

```bash
npx tapsmith test
```

## Setup and configuration

| Appium | Tapsmith |
|---|---|
| `npm install -g appium`, `appium driver install uiautomator2` / `xcuitest`, `appium driver doctor` | `npm install -D tapsmith`, [`npx tapsmith init`](getting-started.md#quick-setup-recommended), `npx tapsmith doctor` |
| Starting the Appium server (or WebdriverIO's Appium service) | Nothing: `npx tapsmith test` starts what it needs |
| WebDriverAgent signing for physical iPhones | `npx tapsmith ios build-agent` ([iOS physical devices](ios-physical-devices.md)) |
| One capabilities set per device or platform | One [project](configuration.md#projects-with-per-device-targeting) per device or platform, selected with `--project` |
| Capabilities from environment variables | Environment variables read with `process.env` in `tapsmith.config.ts` |
| Parallel sessions (`maxInstances`, Selenium Grid) on several devices | `workers: N` or `--workers N`, one device per worker; `launchEmulators: true` with an `avd` starts emulators for you ([Parallel execution](parallel-and-sharding.md)) |
| Splitting a suite across CI machines | `npx tapsmith test --shard=1/4` and `npx tapsmith merge-reports` ([CI sharding](parallel-and-sharding.md#ci-sharding)) |
| Your runner's retries (Mocha `retries`, TestNG `retryAnalyzer`) | `retries` in the config or `test.use()` |
| Allure, JUnit or HTML reporters | Built-in `junit`, `html`, `json`, `github` and `blob` [reporters](api-reference.md#reporters) |

For CI, the [CI setup guide](ci-setup.md) has complete GitHub Actions workflows for Android and iOS. There's no Appium server to start or wait for in CI.

## What works differently

**Waiting.** Appium's find commands look for an element once, or poll for the implicit-wait period, and the test waits for state changes itself. Tapsmith builds the waiting in, as Playwright does:

- A locator is lazy: `device.getByText("Welcome")` doesn't search until you act on it or assert on it, so you can define locators up front (in a [screen object](writing-tests.md#screen-object-pattern)) and reuse them across screen changes. There are no stale element references.
- Actions wait for the element to appear, and a tap also waits for it to be enabled and not covered by something else (the keyboard, a sheet, another view).
- `expect(locator)` assertions keep checking until they pass, including absence (`toBeHidden()` waits for the element to go away).
- `driver.pause()` and most explicit waits can simply be deleted.

**Resetting the app.** Appium sets the reset once per session (`noReset`, `fullReset` or the driver's default), and resets between tests are up to you. In Tapsmith the reset is a declared policy, `appReset`, applied before each test file by default, or before every test with `appResetScope: "test"`. React Native and Expo apps that mount [`@tapsmith/react-native`](warm-reset.md) reset in-process in about a second (a release build needs the hooks switched on at build time, as [Warm app reset](warm-reset.md#release-builds-for-e2e) explains). To start tests signed in, sign in once in a setup project and restore the saved state ([Authentication patterns](writing-tests.md#authentication-patterns)).

**Locators.** XPath is the most common source of slow, brittle Appium tests, and Tapsmith steers away from it: role, text and label locators come first, `getByTestId` is the escape hatch, and `locator({ xpath })` is Android-only and discouraged ([Locators](locators.md)). Locators are also **strict**: if one matches several elements, an action throws and lists every match rather than using the first, so use `.first()`, `.nth()` or a narrower locator where you relied on `$` returning the first match.

**Grouping steps.** Tapsmith's test API follows Playwright's, but Playwright's `test.step()` isn't there yet. To group actions under a name in the trace, use `device.tracing.group(name)` and `device.tracing.groupEnd()` ([other Playwright APIs not supported yet](api-reference.md#playwright-apis-not-supported-yet)).

**Counting list rows.** A locator counts what the platform's accessibility tree holds, and for a long, scrolling list the platforms differ: on Android the tree usually holds just the rows on screen, while on iOS it can also hold rows the list has already rendered off screen. So `count()` and `toHaveCount()` on such a list can give a different number on each platform. Assert on the rows you care about instead (bring one into view with `scrollIntoView()`), or count a list that fits on screen.

**WebViews.** The model is close to Appium's contexts: `const webview = await device.webview()` connects to the app's WebView, and `await device.native()` switches back. The difference is what you get in between: a handle with Playwright-style web locators and assertions (`webview.getByRole()`, `webview.locator(css)`, `expect(webview.getByText("Paid")).toBeVisible()`) instead of a WebDriver session pointed at a browser, and no Chromedriver version to match to the device's WebView. The app must have WebView debugging enabled, as it must for Appium ([WebView testing](webview.md)).

**Debugging.** A failed test leaves a screenshot by default. Set `trace: "retain-on-failure"` to also record a step-by-step trace (a screenshot, the view hierarchy and the network traffic for every action), opened with [`npx tapsmith show-trace`](trace-viewer.md). [UI mode](ui-mode.md) replaces Appium Inspector for finding locators, and [watch mode](watch-mode.md) re-runs a file on save on a device session that stays up: only the app reset runs again, not the daemon, agent and install.

### Not supported yet

Appium covers more platforms and device features than Tapsmith does today:

- **Other platforms and drivers:** Tapsmith tests Android and iOS apps only. Appium's Espresso, Flutter, Windows, Mac and other drivers have no counterpart, and neither do Appium plugins.
- **Other languages:** Tapsmith tests are written in TypeScript. A suite in Java, Python, Ruby or C# has to be rewritten, not just re-pointed.
- **Remote and cloud devices:** Tapsmith drives emulators, simulators and devices attached to the machine it runs on. It has no WebDriver endpoint, so it can't run on Selenium Grid or a cloud device provider through Appium's protocol.
- **Device simulation:** setting the GPS location, network conditions (airplane mode, Wi-Fi), biometrics, and pushing or pulling files have no Tapsmith methods.
- **Some iOS permissions:** on an iOS simulator, `grantPermission()` and `revokePermission()` cover the services `xcrun simctl privacy` supports (photos, location, contacts, calendar, microphone, camera, …), which leaves out notifications, among others. On physical iOS devices they are not supported at all.
- **Mobile browsers:** testing a website in Chrome or Safari on the device. Tapsmith tests apps (and the WebViews inside them).
- **Arbitrary shell commands:** there is no counterpart to `mobile: shell`.

## Migrating incrementally

An Appium suite and a Tapsmith suite can test the same build from the same repository while you move over:

1. **Keep the suites apart.** Put Tapsmith tests in their own folder, with names ending in `.tapsmith.ts`, and run them as their own CI job. Don't point both at the same device at the same time: two tools driving one device interfere with each other.
2. **Start with the slowest and flakiest tests.** Tests full of explicit waits and XPath tend to gain the most, and they show the team the difference quickly.
3. **Port page objects first.** Appium page objects map onto [screen objects](writing-tests.md#screen-object-pattern): replace each `$(selector)` getter with a `getBy*` locator, and drop the waits inside their methods.
4. **Replace both platform variants at once.** Where your suite has separate Android and iOS selectors or page objects, one set of role and text locators often covers both. Run the ported tests on both platforms with two projects.
5. **Retire Appium when the last test is ported**: remove the Appium server and drivers from your CI images and your capabilities files.

See also: [Getting started](getting-started.md), [Writing tests](writing-tests.md), [Locators](locators.md), [API reference](api-reference.md).
