# Migrating from Maestro

This guide is for teams with a Maestro suite who want to move it to Tapsmith. It maps Maestro's concepts onto Tapsmith's, ports one flow side by side, and lists what works differently, including what Tapsmith doesn't do yet.

> Written against **Maestro CLI 2.11.0** and its documentation as of October 2026. Maestro changes quickly; check [its docs](https://docs.maestro.dev) for the version you run.

## The big differences

- **YAML flows become TypeScript tests.** A Maestro flow is a list of commands in YAML, with JavaScript for the parts YAML can't express. A Tapsmith test is a TypeScript function, so loops, conditions, helpers, shared screen objects and type checking come from the language rather than from extra commands.
- **The test runner is built in.** Tapsmith has Playwright's runner shape: `test()`, `describe()`, hooks, fixtures, retries, projects, reporters, workers and sharding, configured in one `tapsmith.config.ts`.
- **Waiting is per action and per assertion.** Maestro retries element lookups for a short window and waits for the screen to settle. In Tapsmith every action waits for its element to appear (a tap also waits for it to be enabled and not covered), and every `expect()` on an element retries until it passes, both up to the `timeout` in your config (30 s by default).
- **The app is reset for you.** Maestro flows usually start with `launchApp: { clearState: true }`. Tapsmith resets the app before each test file by default, and can reset in-process, in about a second, for React Native apps.

## Concept mapping

| Maestro | Tapsmith |
|---|---|
| Flow file (`login.yaml`) | Test file (`login.tapsmith.ts`) containing one or more [`test()`](api-reference.md#testname-string-fn-fixtures-testfixtures--promisevoid-void) calls |
| `appId:` in the flow header | `package` in [`tapsmith.config.ts`](configuration.md) (one config for the whole suite) |
| `tapOn: "Sign in"` | [`device.getByText("Sign in").tap()`](api-reference.md#elementhandletap-promisevoid), or better [`device.getByRole("button", { name: "Sign in" }).tap()`](api-reference.md#devicegetbyrolerole-string-options-elementhandle) |
| `tapOn: { id: "email-input" }` | [`device.getByTestId("email-input").tap()`](api-reference.md#devicegetbytestidtestid-string-elementhandle) |
| `tapOn: { point: "50%,50%" }` | [`device.tapXY(x, y)`](api-reference.md#devicetapxyx-number-y-number-promisevoid) (in screen coordinates, not percentages: pixels on Android, points on iOS) |
| `doubleTapOn` / `longPressOn` | [`.doubleTap()`](api-reference.md#elementhandledoubletapoptions--intervalms-number--promisevoid) / [`.longPress()`](api-reference.md#elementhandlelongpressdurationms-number-promisevoid) |
| `inputText` (into the focused field) | [`locator.type(text)`](api-reference.md#elementhandletypetext-string-options--delay-number--promisevoid) on the field itself (for an empty field; into a field that already has text, `type()` replaces it on Android and adds to it on iOS), or [`device.inputText(text)`](api-reference.md#deviceinputtexttext-string-promisevoid) for the focused field |
| `eraseText` | [`.clear()`](api-reference.md#elementhandleclear-promisevoid) or [`.clearAndType(text)`](api-reference.md#elementhandleclearandtypetext-string-options--delay-number--promisevoid) |
| `assertVisible` / `assertNotVisible` | [`await expect(locator).toBeVisible()`](api-reference.md#tobevisibleoptions-promisevoid) / [`.toBeHidden()`](api-reference.md#tobehiddenoptions-promisevoid) |
| `extendedWaitUntil` | `expect(locator).toBeVisible({ timeout: 60_000 })`, or [`locator.waitFor()`](api-reference.md#elementhandlewaitforoptions-promisevoid) |
| `assertTrue` | [`expect(value)`](api-reference.md#expectvalue-unknown-genericassertions) with any generic matcher, or [`expect.poll()`](api-reference.md#expectpollfn---unknown--promiseunknown-options-polloptions-genericassertions) for a value that changes |
| `scroll` / `swipe` | [`device.swipe("up")`](api-reference.md#deviceswipedirection-string-options-swipeoptions-promisevoid), or [`locator.scroll()`](api-reference.md#elementhandlescrolldirection-string-options--distance-number--promisevoid) on a scroll view |
| `scrollUntilVisible` | [`locator.scrollIntoView()`](api-reference.md#elementhandlescrollintoviewoptions--direction-string-maxscrolls-number-speed-number--promisevoid) |
| `hideKeyboard` | [`device.hideKeyboard()`](api-reference.md#devicehidekeyboard-promisevoid) |
| `back` / `pressKey` | [`device.pressBack()`](api-reference.md#devicepressback-promisevoid-android-only) (Android) / [`device.pressKey(key)`](api-reference.md#devicepresskeykey-string-promisevoid) |
| `openLink` | [`device.openDeepLink(url)`](api-reference.md#deviceopendeeplinkuri-string-options-opendeeplinkoptions-promisevoid) |
| `launchApp` | Automatic before each test file; [`device.launchApp(pkg)`](api-reference.md#devicelaunchapppackagename-string-options-launchappoptions-promisevoid) when you need it mid-test |
| `launchApp: { clearState: true }` / `clearState` | The default [`appReset`](writing-tests.md#test-isolation) policy; [`device.resetApp({ mode: "clear" })`](api-reference.md#deviceresetappoptions-promiseappresetresult) mid-test |
| `stopApp` / `killApp` | [`device.terminateApp()`](api-reference.md#deviceterminateapppackagename-string-promisevoid); add [`device.clearAppData(pkg)`](api-reference.md#deviceclearappdatapackagename-string-promisevoid) to clear its data too |
| `runFlow: login.yaml` | A function or a [screen object](writing-tests.md#screen-object-pattern) you import and call; a [custom fixture](writing-tests.md#custom-fixtures-with-testextend) for setup with teardown |
| `runFlow` with `when:` | An `if` statement, with [`locator.isVisible()`](api-reference.md#elementhandleisvisible-promiseboolean) or [`locator.exists()`](api-reference.md#elementhandleexists-promiseboolean) as the condition |
| `repeat` / `retry` | A `for` loop / the [`retries`](configuration.md#all-options) option for whole tests |
| `env:` and `${VAR}` | `process.env.VAR` in tests and config |
| `onFlowStart` / `onFlowComplete` | [`beforeEach` / `afterEach`](writing-tests.md#hooks) (or `beforeAll` / `afterAll`) |
| `tags:` with `--include-tags` | A tag in the test title (`"checkout @smoke"`) with [`--grep @smoke`](api-reference.md#tapsmith-test---grep-pattern--tapsmith-test--g-pattern) |
| `takeScreenshot` | [`device.takeScreenshot()`](api-reference.md#devicetakescreenshot-promisescreenshotresponse); failures are captured automatically (`screenshot: "only-on-failure"`) |
| `startRecording` / `stopRecording` | The [`video`](api-reference.md#video-recording) option, or a [trace](trace-viewer.md), which records every action with screenshots, the view hierarchy and network traffic |
| `setOrientation` / `setClipboard` | [`device.setOrientation()`](api-reference.md#devicesetorientationorientation-orientation-promisevoid) / [`device.setClipboard()`](api-reference.md#devicesetclipboardtext-string-promisevoid) |
| `setPermissions` | [`device.grantPermission()`](api-reference.md#devicegrantpermissionpackagename-string-permission-string-promisevoid) / `revokePermission()` (Android, and iOS simulators) |
| Maestro Studio | [UI mode](ui-mode.md) (`npx tapsmith test --ui`): a live device mirror, a locator picker, and your tests in one window |
| `maestro hierarchy` | The Hierarchy tab of the [trace viewer](trace-viewer.md) or UI mode, or the [`tapsmith_snapshot`](mcp-server.md#tapsmith_snapshot) MCP tool |
| `maestro mcp` | [`npx tapsmith mcp-server`](mcp-server.md) |

## Porting a flow

Here is a sign-in flow for the React Native test app in the Tapsmith repository, first in Maestro:

```yaml
# flows/login.yaml
appId: dev.tapsmith.testapp
---
- launchApp:
    clearState: true
- openLink: tapsmithtest:///login
- tapOn:
    id: "email-input"
- inputText: "test@example.com"
- tapOn:
    id: "password-input"
- inputText: "password123"
- hideKeyboard
- tapOn: "Sign in"
- assertVisible: "Login successful!"
```

```yaml
# flows/login-invalid.yaml
appId: dev.tapsmith.testapp
---
- launchApp:
    clearState: true
- openLink: tapsmithtest:///login
- tapOn:
    id: "email-input"
- inputText: "test@example.com"
- tapOn:
    id: "password-input"
- inputText: "wrong"
- hideKeyboard
- tapOn: "Sign in"
- assertVisible: "Invalid credentials"
```

And the same two flows as one Tapsmith test file:

```typescript
// tests/login.tapsmith.ts
import { test, describe, expect } from "tapsmith";

describe("Login", () => {
  // Maestro's `clearState: true` before every flow: a fresh app before each test.
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

```typescript
// tapsmith.config.ts
import { defineConfig } from "tapsmith";

export default defineConfig({
  testMatch: ["**/*.tapsmith.ts"],
  apk: "./android/app/build/outputs/apk/release/app-release.apk",
  package: "dev.tapsmith.testapp",
});
```

What changed, line by line:

- **`appId`** moved into the config as `package`, along with the build to install (`apk`, or for iOS `platform: "ios"`, `app` and the `simulator` to boot). Tapsmith installs the build and launches the app before the first test of each file; there is no `launchApp` step.
- **`launchApp: { clearState: true }`** became `test.use({ appResetScope: "test" })`. Without that line, Tapsmith resets the app once per test file rather than before every test (a clear, or a warm reset when the app mounts [`@tapsmith/react-native`](warm-reset.md)), which is faster and is often what a suite of separate flows really needs. See [Test isolation](writing-tests.md#test-isolation).
- **`tapOn` followed by `inputText`** became one call: `type()` taps the field and types into it. The fields are found by role and accessible name (`accessibilityLabel` in React Native) rather than by `testID`. `getByTestId("email-input")` also works; Tapsmith recommends user-visible locators first, as Playwright does ([Locators](locators.md)).
- **`tapOn: "Sign in"`** became `getByRole("button", { name: "Sign in" })`. Maestro treats `text` as a regular expression; `getByText` matches a substring unless you pass `{ exact: true }`, and `getByRole`'s `name` is a case-insensitive substring. If a locator matches more than one element, Tapsmith throws a [strict mode](api-reference.md#strict-mode) error listing them instead of tapping the first.
- **`assertVisible`** became `await expect(...).toBeVisible()`, which retries until the text appears or the timeout passes.

Run it with:

```bash
npx tapsmith test
```

## Setup and configuration

| Maestro | Tapsmith |
|---|---|
| Install the Maestro CLI | `npm install -D tapsmith` in your project, then [`npx tapsmith init`](getting-started.md#quick-setup-recommended) |
| `appId` in every flow | `package` once in `tapsmith.config.ts`; per platform in [projects](configuration.md#projects-with-per-device-targeting) |
| You install the app (or `maestro cloud --app-file`) | `apk` / `app` in the config: Tapsmith installs it |
| `maestro test flows/` | `npx tapsmith test` (files from `testMatch`), or `npx tapsmith test tests/login.tapsmith.ts` |
| Workspace `config.yaml` (flow order, tags) | `tapsmith.config.ts`: `testMatch`, `projects`, `retries`, `timeout`, `reporter` |
| `-e KEY=VALUE`, `MAESTRO_*` shell variables | Ordinary environment variables, read with `process.env` (load a `.env` file with `dotenv` in your config if you like) |
| `--device <id>` | `npx tapsmith test --device emulator-5554`, or `device` / `simulator` in the config |
| `--shard-split N` (one machine, N devices) | `workers: N` or `--workers N`, with `launchEmulators: true` and an `avd` to start emulators for you ([Parallel execution](parallel-and-sharding.md)) |
| Splitting across CI machines | `npx tapsmith test --shard=1/4` and `npx tapsmith merge-reports` ([CI sharding](parallel-and-sharding.md#ci-sharding)) |
| `--format junit` | `reporter: "junit"`, with `html`, `json`, `github` and `blob` also built in ([Reporters](api-reference.md#reporters)) |

For CI, the [CI setup guide](ci-setup.md) has complete GitHub Actions workflows for Android and iOS.

Name Tapsmith test files `*.tapsmith.ts` (what `tapsmith init` sets up), so that Jest or Vitest in the same project never picks them up as unit tests ([why](getting-started.md#tapsmith-tests-and-your-unit-tests)).

## What works differently

**Waiting.** Tapsmith has no `waitForAnimationToEnd` or fixed waits to port. An action waits for its element to appear, and a tap also waits for it to be enabled and not covered by something else (the keyboard, a sheet, another view) before tapping. An assertion keeps re-checking until it passes. Both give up at the `timeout` from your config (30 s by default), or the `{ timeout }` you pass. If you have `extendedWaitUntil` with a long timeout, pass the same timeout to the assertion.

**Resetting the app.** The `appReset` policy replaces `clearState` and `clearKeychain` (on an iOS simulator, a clear also wipes the simulator's keychain). By default the app is cleared once per test file, so the tests in one file share the app: the second test starts where the first left off. Add `test.use({ appResetScope: "test" })` to a file or `describe` to reset before every test, as the example does. React Native and Expo apps that mount [`@tapsmith/react-native`](warm-reset.md) reset in-process in about a second instead of being cleared and relaunched (a release build needs the hooks switched on at build time, as [Warm app reset](warm-reset.md#release-builds-for-e2e) explains). To start tests already signed in, sign in once in a setup project and restore the saved state ([Authentication patterns](writing-tests.md#authentication-patterns)), rather than running a login subflow at the top of every test.

**Locators.** Maestro treats `text` and `id` as regular expressions, and relational selectors (`below`, `childOf`, …) narrow them. In Tapsmith:

- `getByText("Sign in")` is a substring match; `{ exact: true }` matches the whole text; a `RegExp` (`getByText(/^Sign in$/i)`) works as in JavaScript.
- `getByRole(role, { name })` checks what the element is as well as its label, which also makes the app more accessible ([Making React Native apps testable](locators.md#making-react-native-apps-testable-and-accessible)).
- Instead of relational selectors, scope a locator inside another (`device.getByTestId("row-5").getByRole("button", { name: "Delete" })`), or narrow it with `filter()`, `first()`, `nth()`, `and()` and `or()` ([ElementHandle](api-reference.md#elementhandle)). Position on screen (`below`, `leftOf`) has no locator equivalent.
- Ambiguity is an error. When a locator matches several elements, Tapsmith's strict mode refuses to guess: it reports every match and suggests a unique locator for each.

**Counting list rows.** A locator counts what the platform's accessibility tree holds. On Android that is only the rows on screen; on iOS it can also include rows the list has already rendered off screen. So `count()` and `toHaveCount()` on a long, scrolling list can give a different number on each platform. Assert on the rows you care about instead (bring one into view with `scrollIntoView()`), or count a list that fits on screen.

**Conditional steps.** `runFlow` with `when: visible:` becomes an `if`. Use `isVisible()` or `exists()`, which answer without waiting out the timeout (an absent element costs a second read once the screen settles, usually a second or two):

```typescript
const notNow = device.getByRole("button", { name: "Not now" });
if (await notNow.isVisible()) {
  await notNow.tap();
}
```

**Debugging.** A failed test leaves a screenshot by default. Turn on traces (`trace: "retain-on-failure"` in the config) to get a step-by-step record of each failed test with a screenshot, the view hierarchy and the network traffic for every action, opened with [`npx tapsmith show-trace`](trace-viewer.md). For writing tests interactively, [UI mode](ui-mode.md) and [watch mode](watch-mode.md) keep the device session (daemon, agent and installed app) up between runs, so a re-run only resets the app.

### Not supported yet

Some Maestro commands have no Tapsmith equivalent at the moment. Plan to keep these flows in Maestro, or find another way to cover them:

- **Device state:** `setLocation`, `travel` (moving the device's location along a route), `setAirplaneMode` / `toggleAirplaneMode` and `addMedia`. There are no Tapsmith methods for these.
- **Some iOS permissions:** on an iOS simulator, `grantPermission()` and `revokePermission()` cover the services `xcrun simctl privacy` supports (photos, location, contacts, calendar, microphone, camera, …), which leaves out notifications, among others. On physical iOS devices they are not supported at all.
- **Launch arguments:** `launchApp`'s `arguments` have no counterpart; `device.launchApp()` takes an Android `activity`, not arguments.
- **AI and visual commands:** `assertWithAI`, `assertNoDefectsWithAI`, `extractTextWithAI` and `assertScreenshot` (screenshot comparison).
- **Web testing:** Maestro can drive a desktop browser. Tapsmith tests native mobile apps; content inside your app's WebViews is covered by [WebView testing](webview.md).
- **A hosted device cloud:** Tapsmith runs on emulators, simulators and devices you provide, locally or in your own CI.
- **Playwright's `test.step()`:** Tapsmith's test API follows Playwright's, but `test.step()` isn't there yet. Group actions in the trace with `device.tracing.group(name)` and `device.tracing.groupEnd()` instead ([other Playwright APIs not supported yet](api-reference.md#playwright-apis-not-supported-yet)).

## Migrating incrementally

You don't have to port everything at once. Both tools drive the same builds, so they can live in one repository:

1. **Start with the flows that hurt most**: the flakiest, the slowest, or the ones that most need logic YAML can't express.
2. **Keep the two suites apart.** Put Tapsmith tests in their own folder (`tests/`), next to your Maestro `flows/` (or `.maestro/`), and give Tapsmith its own CI job. Don't run both against the same device at the same time: two tools driving one device will interfere with each other.
3. **Port shared subflows first.** A `runFlow: login.yaml` that many flows call becomes one screen object or fixture, which every ported test then reuses.
4. **Retire each flow once its Tapsmith test has been green in CI for a while**, and delete the Maestro job when the last one goes.
5. **Revisit isolation once the suite is ported.** Ported flows often reset before every test; per-file resets, or the [warm reset hooks](warm-reset.md) in a React Native app, usually make the suite much faster.

See also: [Getting started](getting-started.md), [Writing tests](writing-tests.md), [Locators](locators.md), [API reference](api-reference.md).
