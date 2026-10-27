# Tapsmith

Mobile app testing framework with a Playwright-inspired API. Three-tier architecture:
**TypeScript SDK** (test runner + assertions) → **gRPC** → **Rust daemon** (tapsmith-core) → **ADB/simctl + socket** → **On-device agent** (Android: Kotlin/UIAutomator2, iOS: Swift/XCUITest).

Each component (`packages/tapsmith`, `packages/tapsmith-core`, `agent`, `ios-agent`, `proto`,
`test-app`, `e2e`, `web-tests`, …) has independent dependencies and build lifecycle (not a JS
monorepo). `native-ios-test-app/` (plain SwiftUI fixture, `e2e/native-ios/*.native.ts`) is not in
CI yet. `.claude/skills/` is tracked; the rest of `.claude/` is git-ignored.

More guidance loads on demand: `packages/tapsmith/CLAUDE.md` (TS conventions, the five run
paths) and `web-tests/CLAUDE.md`. Releases and published npm packages: see `.github/releasing.md`.

## Build & test commands

### Rust daemon (`packages/tapsmith-core/`)
```bash
cargo fmt -- --check    # formatting
cargo clippy -- -D warnings  # lint (warnings are errors)
cargo test
cargo build --release
```
Requires `protobuf-compiler` installed for tonic-prost-build.

### Android agent (`agent/`)
```bash
./gradlew assembleDebug
./gradlew testDebugUnitTest   # JVM unit tests (no device); CI: android job
./gradlew ktlintCheck
```

### iOS agent (`ios-agent/`)
```bash
ios-agent/Tests/run-unit-tests.sh            # host-side unit tests (no simulator); CI: rust-macos job
cd ios-agent && ./create-xcode-project.sh    # first time only
# Simulator build (unsigned, builds once per iOS version):
xcodebuild build-for-testing \
  -project TapsmithAgent.xcodeproj \
  -scheme TapsmithAgentUITests \
  -destination 'platform=iOS Simulator,name=iPhone 16'
# Physical device build (signed via the Tapsmith CLI, one-time per device/profile):
npx tapsmith ios build-agent                    # auto-detects team ID from Xcode
```

See `docs/ios-physical-devices.md` for the full physical-device walkthrough.

### Proto (`proto/`)
```bash
buf lint proto/
buf breaking proto/ --against '.git#ref=origin/main,subdir=proto'
```

### Web tests (`web-tests/`)
Hermetic Playwright suites for the trace viewer and UI mode (no device needed). They test the
**built bundles**: run `npm run build` in `packages/tapsmith` first, and again after any change to
either app. Details in `web-tests/CLAUDE.md`.

## CI

GitHub Actions runs 9 parallel jobs: `proto-lint`, `typescript`, `rust`, `rust-macos`, `android`,
`website`, `test-app`, `react-native`, `ui-web`. All must pass. See `.github/workflows/ci.yml`.

The external [DCO GitHub App](https://github.com/apps/dco) supplies the **DCO** check required
by the `main` ruleset, configured by `.github/dco.yml` on the default branch.
**Sign your commits with `git commit -s`**, including maintainer commits (see `CONTRIBUTING.md`).
The app accepts the author or committer's sign-off,
exempts merges and GitHub-recognised bots, and allows authors to repair their own missing
sign-offs with individual remediation commits. Repository setup is in `.github/dco-setup.md`.

Dependency updates are handled by **Renovate** (`.github/renovate.json5`, the comment at the top
explains the policy). It opens grouped PRs on Monday mornings and merges non-major updates itself
once every check is green. Majors get one PR per area; dev-only ones (npm devDependencies, website, tools) also merge on green. Majors of shipped code and GitHub Actions, runtime dependencies of the published SDK, and Expo SDK upgrades
of `test-app` (done by hand with `npx expo install --fix`) wait for a human. The "Dependency
Dashboard" issue lists everything pending. Dependabot is used only for alerts, which Renovate turns
into immediate fix PRs; Dependabot security-update PRs are deliberately left off so the two don't
open duplicates.

Device E2E runs separately on every PR: `e2e-android.yml` (ubuntu + KVM emulator, 5 shards) and
`e2e-ios.yml` (macOS simulators, 3 shards). macOS runners are capped at 5 concurrent jobs org-wide,
so `e2e-ios.yml` skips draft PRs (it starts when the PR is marked ready), skips changes that cannot
reach an iOS run (its `paths` lists), and skips each macOS build job whose output an ubuntu `gate`
job finds already cached. `e2e-android-hookless.yml` covers the hook-less reset
path (test app built without `EXPO_PUBLIC_TAPSMITH_HOOKS`) weekly, on manual dispatch, and on PRs
touching the reset-path sources. `e2e-provisioning.yml` (same triggers, for the emulator/simulator
provisioning sources) is where Tapsmith launches or boots its own devices from nothing: the sharded
jobs pre-boot in the workflow, and the Android `Multi-device` job pre-boots only its primary and lets
Tapsmith launch the second member. Both start or end with a host check
(`e2e/verify-provisioning.mjs`, checks unit-tested in `e2e/utils/provisioning-checks.mjs`), so an
adopted device or an untracked leftover emulator/simulator fails the job even when every test passes.

Shard 1 of each device workflow also runs `e2e/verify-trace-archive.mjs`, which records one trace
with `--trace on` and then asserts what is *inside* the archive — screenshots that decode at the
device's real resolution, hierarchy dumps containing the element each action resolved, and the
app's real HTTPS traffic. The sharded runs record `retain-on-failure` traces nobody opens, so this
is the only place a trace that packages cleanly but holds the wrong data gets caught. The checks
live in `e2e/utils/trace-archive-checks.mjs` and are themselves unit-tested by the `typescript`
job's **E2E helper tests** step (`cd e2e && npm test`, no device needed);
`--verify-only <trace.zip>` re-runs them against a trace downloaded from a CI artifact.

The archive format is a versioned public contract (`docs/trace-format.md`): `trace/types.ts`,
`packages/tapsmith/schema/trace-format.schema.json` and the docs page move together, and
`TRACE_FORMAT_VERSION` (`trace/trace-format.ts`) is bumped for any change an existing reader could
misread (additive fields don't bump it). Local paths go into the archive rootDir-relative via
`trace/archive-paths.ts`. `trace-format-schema.test.ts` validates a packaged archive against the
schema, and the device checks validate a real one.

## Code style

`e2e/` has no ESLint config — match the surrounding file's style there (e.g. semicolons).
TypeScript conventions for the SDK live in `packages/tapsmith/CLAUDE.md`.

## Design principles

- **Playwright is the bar.** The goal is to match Playwright's robustness, reliability, and developer experience for mobile. Don't cut corners -- handle edge cases, add proper error messages, implement auto-waiting correctly, and write thorough tests.
- **Don't reinvent the wheel.** Use well-maintained open source packages rather than writing custom implementations. If a proven library exists for the job (parsing, diffing, formatting, etc.), prefer it over hand-rolling.

## Documentation

- **Keep `docs/api-reference.md` up to date** when adding or changing public API (new methods on Device, ElementHandle, new assertions, new types, etc.). This is the single source of truth for users.
- Other docs (`getting-started.md`, `locators.md`, `configuration.md`, `ci-setup.md`) only need updates if the feature changes user-facing workflows.

## Commit style

Descriptive imperative messages. Feature work happens on branches (e.g., `feat/locator-api-enhancements`) with PRs to main.
