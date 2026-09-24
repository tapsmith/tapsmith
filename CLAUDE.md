# Tapsmith

Mobile app testing framework with a Playwright-inspired API. Three-tier architecture:
**TypeScript SDK** (test runner + assertions) → **gRPC** → **Rust daemon** (tapsmith-core) → **ADB/simctl + socket** → **On-device agent** (Android: Kotlin/UIAutomator2, iOS: Swift/XCUITest).

## Project structure

```
packages/tapsmith/        # TypeScript SDK — locators, element handles, assertions, runner, CLI
packages/tapsmith-core/   # Rust daemon — gRPC server, ADB/simctl bridge, device management
agent/                    # Android Kotlin agent — UIAutomator2 instrumentation
ios-agent/                # iOS Swift agent — XCUITest instrumentation
proto/tapsmith.proto      # gRPC contract (single proto file, buf for linting)
npm-packages/             # Platform-specific npm packages (@tapsmith/core-{os}-{arch}) for daemon binary distribution
docs/                     # User-facing documentation
test-app/                 # React Native (Expo) test app for E2E testing
e2e/                      # E2E test suite run against the test app
.claude/skills/           # Claude Code project skills (implement-ticket(s), review-loop, qa-this-branch); .claude/ otherwise git-ignored
```

Each component has independent dependencies and build lifecycle (not a JS monorepo).

## Build & test commands

### TypeScript SDK (`packages/tapsmith/`)
```bash
npm ci                  # install deps
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run test            # vitest run (unit tests, no device needed)
npm run knip            # unused code detection
npm run build           # tsc → dist/
```

### Rust daemon (`packages/tapsmith-core/`)
```bash
cargo fmt -- --check    # formatting
cargo clippy -- -D warnings  # lint (warnings are errors)
cargo test
cargo build --release
```
Requires `protobuf-compiler` installed for tonic-build.

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
npx tapsmith build-ios-agent                    # auto-detects team ID from Xcode
```

See `docs/ios-physical-devices.md` for the full physical-device walkthrough.

### Proto (`proto/`)
```bash
buf lint proto/
buf breaking proto/ --against '.git#ref=origin/main,subdir=proto'
```

### Web tests (`web-tests/`)
```bash
npm ci
npx playwright install chromium
npm run typecheck                          # tsc --noEmit
npm run test                               # both projects
npx playwright test --project=ui-mode
npx playwright test --project=trace-viewer
npm run test:ui                            # Playwright's UI runner, for authoring
```
Hermetic Playwright suites for the two web apps — **no device or daemon needed**, ~20s for all of
them. Two projects: `ui-mode` drives the SPA through an intercepted WebSocket
(`page.routeWebSocket()`); `trace-viewer` drives the standalone viewer through an intercepted trace
archive. The inspection components both apps share (DetailTabs, NetworkTab, HierarchyTree,
LocatorPlayground, ActionsPanel, ScreenshotPanel) are covered via `trace-viewer`, where a static
archive is much less setup than a live session.

Both suites test the **built bundles**, so `npm run build` in `packages/tapsmith` must run first —
and again after any change to either app. Pane objects follow the same screen-object conventions as
`e2e/screens/` (see `docs/writing-tests.md`). See `web-tests/README.md` for the locator policy and
what is deliberately not covered.

## CI

GitHub Actions runs 9 parallel jobs: `proto-lint`, `typescript`, `rust`, `rust-macos`, `android`,
`website`, `test-app`, `react-native`, `ui-web`. All must pass. See `.github/workflows/ci.yml`.

The external [DCO GitHub App](https://github.com/apps/dco) supplies the **DCO** check required
by the `main` ruleset, configured by `.github/dco.yml` on the default branch.
**Sign your commits with `git commit -s`**, including maintainer commits (see `CONTRIBUTING.md`).
The app accepts the author or committer's sign-off,
exempts merges and GitHub-recognised bots, and allows authors to repair their own missing
sign-offs with individual remediation commits. Repository setup is in `.github/dco-setup.md`.

Device E2E runs separately on every PR: `e2e-android.yml` (ubuntu + KVM emulator, 5 shards) and
`e2e-ios.yml` (macOS simulators, 5 shards). `e2e-android-hookless.yml` covers the hook-less reset
path (test app built without `EXPO_PUBLIC_TAPSMITH_HOOKS`) weekly, on manual dispatch, and on PRs
touching the reset-path sources.

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

## npm packaging & releases

**Cutting a release (automated).** Run the **Prepare release** workflow from the Actions tab (`.github/workflows/prepare-release.yml`) with a version input of `patch`, `minor`, `major`, or an explicit version like `0.4.0`. It runs `scripts/bump-version.sh` and opens a labelled `Release vX.Y.Z` PR (CI runs on it). Review and merge the PR — merging triggers:

1. **`tag-release.yml`** — reads the version that landed on `main`, tags that commit `vX.Y.Z`, and pushes the tag (over SSH so `release.yml` fires).
2. **`release.yml`** — the existing publish pipeline (triggered by the `v*` tag), which now ends with a **`github-release`** job that creates the GitHub Release with auto-generated notes and dispatches `deploy-website.yml`.
3. **`deploy-website.yml`** — rebuilds the docs site; `website/scripts/sync-releases.mjs` fetches the published releases into the **Changelog** page (in the docs sidebar).

Release notes are grouped by PR label per `.github/release.yml` (Features/Bug Fixes/Docs/Maintenance/Other) and published both on the repo's **Releases** page and the website **Changelog**. Label your PRs (`enhancement`, `bug`, `documentation`, …) to control grouping.

**One-time setup (already done):** a repo **deploy key with write access** whose private half is stored as the secret **`RELEASE_SSH_KEY`**. It's required because the default `GITHUB_TOKEN` cannot trigger further workflow runs — so the release branch (for CI on the PR) and the version tag (for `release.yml`) are pushed over SSH with this key instead. Both automation workflows fail with a clear message if the secret is unset. To rotate: `ssh-keygen -t ed25519 -f k -N ""`, `gh repo deploy-key add k.pub -w -t release-automation`, `gh secret set RELEASE_SSH_KEY < k`, then delete the old deploy key.

**Manual escape hatch:** pushing a `v*` tag by hand (`git tag v0.4.0 && git push --tags`) still triggers `release.yml` directly, which then creates the Release and redeploys the website.

The release workflow (`.github/workflows/release.yml`) builds and publishes:

- **`@tapsmith/core-{darwin,linux}-{arm64,x64}`**: Platform-specific packages containing only the prebuilt `tapsmith-core` binary. Listed as `optionalDependencies` so npm auto-installs only the matching platform.
- **`@tapsmith/agent-android`**: Android agent APKs. Listed as an `optionalDependency` of the main package and auto-installed on any platform.
- **`tapsmith`**: Main package. Bundles the TypeScript SDK, CLI, proto file (`dist/proto/`), and trace viewer/UI mode web apps.

**Binary resolution** (`daemon-bin.ts`): Uses `require.resolve()` to find the platform package, with fallbacks to monorepo builds, `TAPSMITH_DAEMON_BIN` env var, and `PATH`.

**Agent APK resolution** (`agent-resolve.ts`): Resolves APKs from the `@tapsmith/agent-android` npm package first, then monorepo build output. Config `agentApk`/`agentTestApk` override.

**Proto file** (`grpc-client.ts`): Tries `dist/proto/tapsmith.proto` (npm-installed), falls back to `../../proto/tapsmith.proto` (monorepo).

## TypeScript conventions

- **ESM with `.js` extensions** in all imports (even for `.ts` files) — required by Node16 module resolution
- **Semicolons required** in `packages/tapsmith` (ESLint `semi: always`); `e2e/` has no ESLint config — match the surrounding file's style there
- **Strict TypeScript** — `strict: true` in tsconfig
- **`_prefix`** for internal/private members (e.g., `_client`, `_selector`)
- **Section dividers**: `// ─── Name ───` in major files
- **Type exports** use explicit `type` keyword
- **No barrel exports** — `index.ts` has explicit re-exports
- **Unused vars**: `_` prefix to suppress warnings (`argsIgnorePattern: '^_'`)
- **`@typescript-eslint/no-explicit-any`**: error — avoid `any`; use `unknown` with type narrowing, or targeted `eslint-disable` with a justification comment for genuinely untyped boundaries (e.g., dynamic proto loading)
- Tests live in `src/__tests__/*.test.ts` and use Vitest with mocks (no live device)

## Key SDK abstractions

- **Selectors** (`selectors.ts`): Immutable, built via `role()`, `text()`, `contentDesc()`, etc. Serialized to proto via `selectorToProto()`. Accessibility-first (prefer role/text over className/xpath).
- **ElementHandle** (`element-handle.ts`): Lazy-resolved locator. Supports `.first()`, `.last()`, `.nth()`, `.all()`, `.filter()`, `.and()`, `.or()`, `.element()` for scoping. AND binds tighter than OR.
- **Device** (`device.ts`): Main user-facing API wrapping gRPC client. Default timeout 30s.
- **Assertions** (`expect.ts`): Locator assertions (auto-waiting, 250ms poll) + generic value assertions. Supports `.not`, `expect.soft()`, `expect.poll()`.
- **Runner** (`runner.ts`): Custom test runner with `test()`, `describe()`, `.only`, `.skip`, hooks, screenshot-on-failure.
- **gRPC client** (`grpc-client.ts`): Dynamic proto loading via `@grpc/proto-loader` (no codegen step on TS side).

## The five run paths (embedders)

Tests execute through five separately-assembled paths. **Anything threaded
per-session — capabilities, install checks, passthrough hosts, new config
keys — must be wired through all of them**, or the missed path degrades
silently (this class of bug has shipped more than once):

1. `cli.ts` — sequential `tapsmith test` (the only path device CI exercises)
2. `worker-runner.ts` — parallel workers (`--workers N`, dispatcher.ts)
3. `ui-mode/ui-worker.ts` — every UI-mode session
4. `watch-run.ts` — headless watch mode's fresh-forked child per re-run
5. `mcp/headless-dispatcher.ts` — `tapsmith mcp-server`, which forks the same
   `watch-run.ts` children (so 4 and 5 share child code but have separate
   parent-side state threading)

When adding a per-session concern, prefer a **required** option on
`runTestFile` over an optional one — a compile error in every embedder beats
a silent default (see `RunOptions.resetCapabilities` and `RunOptions.runMode`
for the precedent), and verify degraded paths loudly (assert the trace's
reset rung, not just pass/fail).

Anonymous usage telemetry (`telemetry.ts`, PILOT-330) rides on this: the
runner reports one event per file tagged with the embedder's `runMode`. Keep
the payload a closed set of fields (the unit test pins the key list) and never
add anything identifying — `docs/telemetry.md` is the public contract.

## Design principles

- **Playwright is the bar.** The goal is to match Playwright's robustness, reliability, and developer experience for mobile. Don't cut corners -- handle edge cases, add proper error messages, implement auto-waiting correctly, and write thorough tests.
- **Don't reinvent the wheel.** Use well-maintained open source packages rather than writing custom implementations. If a proven library exists for the job (parsing, diffing, formatting, etc.), prefer it over hand-rolling.

## Documentation

- **Keep `docs/api-reference.md` up to date** when adding or changing public API (new methods on Device, ElementHandle, new assertions, new types, etc.). This is the single source of truth for users.
- Other docs (`getting-started.md`, `locators.md`, `configuration.md`, `ci-setup.md`) only need updates if the feature changes user-facing workflows.

## Commit style

Descriptive imperative messages. Feature work happens on branches (e.g., `feat/locator-api-enhancements`) with PRs to main.
