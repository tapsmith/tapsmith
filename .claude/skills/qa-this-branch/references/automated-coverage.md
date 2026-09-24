# What is already automated — subtract it, and prove it ran on HEAD

QA's value is the **complement** of automated coverage. Read this in Phase 2 and subtract
it from the matrix before you plan a single probe. But a check only subtracts if it ran —
and passed — on the tree you are testing. "CI is green on this branch" is not the same
claim.

## When CI runs at all

**Every workflow triggers on `pull_request` to `main`** (plus pushes to `main` /
`release/**`, schedules and manual dispatch). **Pushing a feature branch with no PR runs
nothing.** So:

- **No PR** → there is no CI evidence, pushed or not. Every cell an automated check would
  cover is `pending-ci: <job>`, and the verdict can be at best `ready-pending-ci`. Say so;
  do not substitute local suite runs for it (a calling workflow gets CI by opening a draft
  PR).
- **PR open** → CI runs on each push to it. Check it covers *HEAD* (below).

## CI on every PR (`.github/workflows/ci.yml`, 9 parallel jobs)

Workflows change — skim `ci.yml` at HEAD if the branch touches `.github/`.

| Job | Runs | So never hand-run |
|---|---|---|
| **Proto Lint** | `buf lint`, `buf breaking --against origin/main` | proto lint/breaking |
| **TypeScript** | typecheck, lint, `vitest run`, knip, build in `packages/tapsmith`; **E2E helper tests** (`cd e2e && npm test`) | the SDK's static gates, its whole vitest suite, the e2e helper tests |
| **Rust** (ubuntu) | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, release build | daemon gates and unit tests |
| **Rust (macOS)** | the same four, plus **iOS agent host-side unit tests** | the macOS variants, `ios-agent/Tests/run-unit-tests.sh` |
| **Android** | `assembleDebug`, `testDebugUnitTest`, `ktlintCheck` | agent compile, JVM unit tests, ktlint |
| **Website** | typecheck, lint, format:check, knip, build (doc sync + link validation) | website checks, doc link validation |
| **Test App** | typecheck, lint, format:check, knip | `test-app/` static checks |
| **React Native hooks** | typecheck, lint, `npm test`, build | `packages/tapsmith-react-native` checks |
| **Web Tests** | builds the SDK, then `web-tests` typecheck + both Playwright projects | `npm test` in `web-tests/` |

Also on PRs, path-filtered: **iOS Agent** (`ios.yml`, on `ios-agent/**`,
`tapsmith-core/src/ios/**`, `agent_comms.rs`) — a simulator build of the agent.

## Device E2E on every PR

| Workflow | Coverage |
|---|---|
| `e2e-android.yml` | KVM emulator, **5 shards**, `tapsmith.config.android-ci.mjs`, `--workers 1`; shard 1 also runs `verify-trace-archive.mjs`; plus a **Multi-device** job (two emulators, `use.devices` project) |
| `e2e-ios.yml` | macOS simulators, **5 shards**, `tapsmith.config.ios-ci.mjs`, `--workers 1`; shard 1 runs `verify-trace-archive.mjs`. Its **Multi-device** job runs only on `workflow_dispatch`, and its test step is `continue-on-error` — **no iOS multi-device coverage on a PR** |
| `e2e-android-hookless.yml` | the hook-less reset path; on PRs only when they touch `app_reset.rs`, `app-reset.ts`, `session-preflight.ts`, `enabled.ts`, `app-reset.hookless.ts`, its config or workflow |

So the whole `e2e/tests/**` suite runs on both platforms on a PR. Running an e2e file
locally to see it pass is duplicated work.

## Proving a check covers HEAD

Before writing `covered:` in a cell, all of these must hold. If any fails, the cell is
`pending-ci:` (check will run or re-run) or `must-test` (check does not assert it).

1. **The run is for HEAD, and the tree is clean.** Runs for abandoned pre-rebase SHAs
   still show `success` on the branch.

   ```bash
   head=$(git rev-parse HEAD)
   gh pr checks --json name,state,link          # the PR's latest checks
   gh run list --branch "$(git branch --show-current)" --limit 20 \
     --json workflowName,headSha,status,conclusion \
     -q '.[] | "\(.workflowName)  \(.status)/\(.conclusion)  \(.headSha)"'
   ```

   Covered only when the run's `headSha` equals `$head`. A dirty tree means files CI never
   saw: cells touching those files are `pending-ci`. An in-progress run is `pending-ci`
   (in autonomous mode do not wait on it; the caller will).
2. **The job is not advisory.** A `continue-on-error` step leaves the job green whatever
   happens. Check step conclusions for any job you lean on:

   ```bash
   gh api repos/{owner}/{repo}/actions/runs/<run-id>/jobs --paginate \
     --jq '.jobs[] | select(.name|test("<job>")) | .steps[] | "\(.name): \(.conclusion)"'
   ```
3. **The spec actually ran.** A spec that exists can be excluded by the CI config's
   `testMatch`, skipped on one platform, or sharded somewhere you did not look. For an e2e
   spec, grep the passing shards' logs for the test name:
   `gh run view <run-id> --log | grep -F '<test title>'`. A shard that failed before any
   test ran (no `blob-report/`, no `tapsmith-results/` artifact) is infra, not a result.
4. **It asserts your observable.** The suite staying green would not prove your new trace
   field, log line or rung is populated. Read the spec.

A **red** job on HEAD: read `gh run view <id> --log-failed | tail -50`. Decide whether the
branch caused it (compare with main's recent runs of the same job) — a branch-caused red
job is a finding; a known flake is noted with the evidence (check main's recent runs of the job, and any
flake notes in your memory if you have them).

## What automation does NOT cover — this is your scope

- **Mode 2 (parallel workers)** — every device workflow passes `--workers 1`.
- **Modes 3–7** (headless watch, headless MCP, UI mode, UI watch, UI MCP) — no CI job
  starts a watch coordinator, an MCP server or a UI server.
- **The UI-mode SPA against a live server** — `web-tests` intercepts the socket.
- **iOS multi-device** (above), **physical iOS devices**.
- **Anything whose observable no test asserts.**
- **Cross-session and concurrency behaviour** — two sessions, device contention, port
  collisions, orphan cleanup.
- **`doctor` / `verify` / `init` / `setup-*` on a real machine**, first-run and no-config
  states.
- **Recovery and degraded paths** — collision, wedged session, stale build, missing agent.
- **Intent** — no automated check knows what the ticket asked for.

## What is not coverage

None of these subtract anything; a cell they "cover" is `must-test`:

- a previous QA round (any session, any recency, a byte-identical SHA included);
- a `/code-review` or `/review-loop` pass, or a commit message saying a finding was fixed;
- a memory note saying something was "live-verified";
- a green job that does not assert your observable, ran on another SHA, or is advisory.

## When running something CI also runs is still justified

Narrow list; say which in the report so it does not read as padding.

- **Producing an artifact** — one `tapsmith test <file> --trace on` to read a trace field.
- **Reproducing or bisecting a red CI job.**
- **Proving a regression spec earns its keep** — revert the fix, watch the spec go red.
- **No PR exists and the caller asked for a local signal** — the narrowest target (one
  file, one test name), never the whole suite. Without that request, `pending-ci` is the
  complete and correct statement.
