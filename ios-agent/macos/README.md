# macOS agent project

Xcode project that builds the shared `ios-agent/TapsmithAgent/` sources as a
macOS XCUITest bundle (scheme `TapsmithMacAgentUITests`). It is generated from
`project.yml` with [xcodegen](https://github.com/yonaskolb/XcodeGen) and the
generated `TapsmithMacAgent.xcodeproj` is committed, like the iOS one.

## Regenerate

```bash
cd ios-agent/macos && xcodegen generate
```

`../TapsmithAgent` is a `syncedFolder`, so new agent source files are picked up
without regenerating.

## Build and run

```bash
xcodebuild build-for-testing -project TapsmithMacAgent.xcodeproj \
  -scheme TapsmithMacAgentUITests -destination platform=macOS -derivedDataPath <dir>

TEST_RUNNER_TAPSMITH_TARGET_BUNDLE_ID=<bundle id> \
TEST_RUNNER_TAPSMITH_AGENT_PORT=18700 \
TEST_RUNNER_TAPSMITH_TARGET_APP_PATH=<absolute path to .app> \
xcodebuild test-without-building -project TapsmithMacAgent.xcodeproj \
  -scheme TapsmithMacAgentUITests -destination platform=macOS -derivedDataPath <dir>
```

`TAPSMITH_TARGET_APP_PATH` is optional. When set, the agent launches the app by
file path (`XCUIApplication(url:)`); `XCUIApplication(bundleIdentifier:)` only
finds apps in indexed locations such as `/Applications`.

## Why the entitlements file exists

The UI-test runner is sandboxed. Without `com.apple.security.network.server` its
socket listener fails with `bind ... Operation not permitted`, so the daemon
could never connect. `CODE_SIGN_ENTITLEMENTS` on the test target makes Xcode
merge `TapsmithMacAgent.entitlements` into the Runner app; check with
`codesign -d --entitlements - <...>/TapsmithMacAgentUITests-Runner.app`.
