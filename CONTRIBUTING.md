# Contributing to Tapsmith

Thanks for your interest in Tapsmith. Bug reports, documentation fixes and code are all
welcome.

Tapsmith spans four languages and two mobile platforms, so this guide is longer than most.
The parts you need depend on what you're changing -- start with [Licensing and sign-off](#licensing-and-sign-off),
then jump to the component you're touching.

## Licensing and sign-off

### Your contributions stay Apache 2.0

Tapsmith is licensed under the [Apache License 2.0](LICENSE). Under section 5 of that
licence, anything you intentionally submit for inclusion is licensed under the same terms
unless you state otherwise in writing.

In plain terms: **you keep your copyright, and you are not assigning anything to anyone.**
There is no CLA to sign.

### Commercial services

We may build and sell commercial services around Tapsmith -- hosted run history, support,
and similar. Those are built in separate repositories under their own licences. They do not
change the licence of anything in this repository, and contributions made here remain
Apache 2.0 for everyone, including you. We're saying so up front so it is never a surprise
later.

### Sign off your commits

Sign off your contributions under the [Developer Certificate of Origin](DCO), including
documentation changes. This applies to maintainers too. Pass `-s` when you commit:

```bash
git commit -s -m "Fix stale element handle after app restart"
```

That appends a line built from your git `user.name` and `user.email`:

```
Signed-off-by: Jane Developer <jane@example.com>
```

If you commit from VS Code's Source Control view, the repository's workspace settings
(`.vscode/settings.json`) turn on **Git: Always Sign Off**, which adds the same trailer
automatically. Other editors have equivalents; a `prepare-commit-msg` hook works everywhere.
If you forget, `git commit --amend -s --no-edit` fixes the last commit, and the DCO check also
accepts a [remediation commit](https://github.com/apps/dco) so shared history need not be
rewritten.

The DCO is a short statement that you wrote the patch, or otherwise have the right to submit
it under Apache 2.0. Read the full text in [DCO](DCO) -- it's four short clauses.

**It is not a CLA and not a copyright assignment.** It grants the project nothing beyond
what the licence already does. Sign-offs record contributors' certifications about their
right to submit the work; they do not independently verify authorship or ownership.

The [DCO GitHub App](https://github.com/apps/dco) supplies the **DCO** check required by
the `main` ruleset. It checks sign-offs matching the commit author or committer's name and
email. We use its standard exceptions for merge commits and accounts GitHub identifies
as bots. Merge conflict resolutions still
need review, and should carry your sign-off when you create them. Naming an account or
commit author `[bot]` does not qualify it for the bot exception.

`git commit -s` adds a certification in the commit message; it is separate from cryptographic
commit signing (`git commit -S`). A GitHub noreply email is fine; use a consistent Git identity.

If you forget a sign-off on your own commits, you can amend them:

```bash
# Just the last commit
git commit --amend -s --no-edit
git push --force-with-lease

# Several commits: only when every commit in origin/main..HEAD is your own
git fetch origin
git rebase --signoff origin/main
git push --force-with-lease
```

`git rebase --signoff` adds your certification to every commit it rewrites. Check the range
after fetching, and do not use this bulk command if it includes another contributor's work.
Preserve their authorship and existing sign-offs; ask them to repair any missing sign-off
using their own individual remediation commit. Only rewrite a branch when you have
coordinated with anyone using its history.
For shared branches, the app also supports **individual remediation commits**: open the
failed DCO check and follow its instructions to certify your own earlier commits in a
follow-up commit. This is configured in [.github/dco.yml](.github/dco.yml); third-party
remediation is disabled.

If you're passing on an unchanged patch under clause (c), preserve the original author's
identity and sign-off, and add your own certification below it:

```
Signed-off-by: Original Author <original@example.com>
Signed-off-by: You <you@example.com>
```

Never invent another person's sign-off or change authorship to satisfy the check. If an
original sign-off is missing, ask the author to supply it. Work based on appropriately
licensed prior code can also qualify under clause (b); retain the required attribution
and licence notices, explain the source in the PR, and sign off only what you can certify.
Passing the automated check does not replace those obligations.

## Before you start

For anything beyond a small fix, **open an issue first** and say you intend to work on it.
Tapsmith deliberately tracks Playwright's API shape, so a change that looks like an
improvement in isolation may conflict with that. A short conversation up front saves you
building something that can't be merged.

Small fixes -- typos, broken links, an obvious one-line bug -- can go straight to a pull
request.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/tapsmith/` | TypeScript SDK -- locators, element handles, assertions, runner, CLI |
| `packages/tapsmith-core/` | Rust daemon -- gRPC server, ADB/simctl bridge, device management |
| `agent/` | Android agent -- Kotlin, UIAutomator2 instrumentation |
| `ios-agent/` | iOS agent -- Swift, XCUITest instrumentation |
| `proto/tapsmith.proto` | The gRPC contract between SDK and daemon |
| `web-tests/` | Playwright suites for UI mode and the trace viewer |
| `e2e/` | End-to-end suite, run against `test-app/` on a real device |
| `docs/` | User-facing documentation |

A test flows through all three tiers: **TypeScript SDK** -> gRPC -> **Rust daemon** ->
ADB/simctl -> **on-device agent**. Changing the contract between any two of them means
touching `proto/tapsmith.proto` and both sides.

Each component has its own dependencies and build lifecycle -- this is not a JavaScript
monorepo, so there is no root `npm install`.

## Development setup

Install the git hooks once, so the same checks CI runs happen before you commit:

```bash
git config core.hooksPath .githooks
```

The pre-commit hook only runs checks for the components you actually touched.

### TypeScript SDK

```bash
cd packages/tapsmith
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run test          # vitest -- unit tests, no device needed
npm run knip          # unused code detection
npm run build         # tsc -> dist/
```

### Rust daemon

Needs `protobuf-compiler` installed for `tonic-build`.

```bash
cd packages/tapsmith-core
cargo fmt -- --check
cargo clippy -- -D warnings   # warnings are errors
cargo test
```

### Android agent

```bash
cd agent
./gradlew assembleDebug
./gradlew ktlintCheck
```

### iOS agent

```bash
cd ios-agent
./create-xcode-project.sh     # first time only
xcodebuild build-for-testing \
  -project TapsmithAgent.xcodeproj \
  -scheme TapsmithAgentUITests \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

See [docs/ios-physical-devices.md](docs/ios-physical-devices.md) for physical devices.

### Proto

```bash
buf lint proto/
buf breaking proto/ --against '.git#ref=origin/main,subdir=proto'
```

Adding a field to the `Selector` message means handling it in **both** `selectorToProto()`
(`packages/tapsmith/src/selectors.ts`) and `selector_to_json()`
(`packages/tapsmith-core/src/grpc_server.rs`) -- miss either side and the selector is
silently ignored at runtime. `.github/scripts/check-proto-compat.sh` checks this; run it
by hand before you push.

### Web tests

Hermetic Playwright suites for UI mode and the trace viewer -- no device or daemon needed,
around 20 seconds for all of them.

```bash
cd web-tests
npm ci
npx playwright install chromium
npm run test
```

They test the **built** bundles, so run `npm run build` in `packages/tapsmith` first, and
again after any change to either web app.

## Tests

Tapsmith has two testing tiers, and the line between them is whether **anything is attached
at all**:

- **No device** -- Vitest unit tests in `packages/tapsmith/src/__tests__/*.test.ts`, which use
  mocks, and the hermetic Playwright suites in `web-tests/`. Neither needs an emulator, a
  simulator, a phone or a running daemon.
- **Device required** -- the `e2e/` suite, which needs an Android or iOS target. An emulator or
  simulator counts; it does not have to be physical hardware.

Test at the lowest tier that can actually cover the change -- a unit test where the behaviour
allows one, `e2e/` where it genuinely needs a device.

Not everything fits. The Android and iOS agents have no unit-test harness at all, so changes
there are covered by `e2e/` or not at all, and some behaviour (a timing fix, a crash on one
OEM's firmware) resists automated testing entirely. That's an acceptable answer -- say so in
the pull request and describe how you verified it by hand instead. An honest "not tested,
here's why" is worth more than a test that asserts nothing.

You don't need to run `e2e/` locally to open a pull request -- CI runs the Android and iOS
suites on every PR. If you do want to run it, it drives the React Native app in `test-app/`;
see [docs/writing-tests.md](docs/writing-tests.md).

## Coding conventions

TypeScript:

- **ESM with `.js` extensions** in every import, including for `.ts` files -- required by
  Node16 module resolution.
- **Semicolons** in `packages/tapsmith` (ESLint `semi: always`). `e2e/` has no ESLint config;
  match the surrounding file.
- **Strict mode** -- `strict: true`, and avoid `any`. Use `unknown` with narrowing, or a
  targeted `eslint-disable` with a comment explaining why, for genuinely untyped boundaries.
- **`_prefix`** for internal members (`_client`, `_selector`).
- **No barrel exports** -- `index.ts` lists explicit re-exports.
- **Section dividers** in larger files: `// ─── Name ───`.

Across the project:

- Match the style of the file you're editing, including its comment density.
- Prefer a well-maintained library over a hand-rolled implementation.
- **Playwright is the bar.** Handle edge cases, write real error messages, get auto-waiting
  right. Half-implemented behaviour is worse than none.

## Documentation

If you change public API -- a new method on `Device` or `ElementHandle`, a new assertion, a
new type -- update [`docs/api-reference.md`](docs/api-reference.md) in the same pull request.
It is the single source of truth for users.

The other docs (`getting-started.md`, `locators.md`, `configuration.md`, `ci-setup.md`) only
need updating if you've changed a user-facing workflow.

## Pull requests

- Work on a branch (`feat/...`, `fix/...`) and open a pull request against `main`.
- Write descriptive, imperative commit messages: "Add retry to element resolution", not
  "fixes".
- Keep a pull request to one logical change. Unrelated fixes are easier to review separately.
- Fill in the pull request template, including the sign-off checkbox.
- CI must be green. It runs proto lint, TypeScript, Rust (Linux and macOS), Android, website,
  test-app, React Native and web checks in parallel, plus Android and iOS device E2E, and the
  DCO check.

Maintainers may ask for changes to keep the API consistent with Playwright's shape -- that's
about the project's constraints, not the quality of your work.

## Reporting bugs

Open an issue including:

- Tapsmith version (`npx tapsmith --version`), OS, and Node version.
- Platform -- Android or iOS, emulator/simulator or physical device, and the OS version.
- A minimal test that reproduces it.
- What you expected and what happened instead.

A **trace** is the single most useful thing you can attach. Record one with:

```bash
npx tapsmith test --trace on
```

Traces contain screenshots, view hierarchies and captured network traffic from your app, so
check what's in one before posting it publicly.

## Security

Please don't open a public issue for a security vulnerability. Report it privately through
GitHub's private vulnerability reporting, on the repository's **Security** tab, and allow
reasonable time for a fix before disclosing.
