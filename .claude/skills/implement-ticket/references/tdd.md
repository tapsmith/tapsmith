# Test-first, at the lowest tier that can cover it

The PR template asks for exactly this: *new behaviour is tested at the lowest tier that
can actually cover it — a Vitest unit test if it needs no device, an `e2e/` test if it
does*. Test-first is how you get there without writing tests that merely describe the
code you already wrote.

## The loop, per slice

1. **Red.** Write one test for the next behaviour. Run just that test. It must fail, and
   fail **on the assertion** — an import error, a typo or a missing export is not red, it
   is broken. For a bug, the first red test is the reproduction.
2. **Green.** The least code that passes it. Run the test, then the file.
3. **Refactor** with everything green; then run the package-local checks for what you
   touched (below). Commit the slice.

Keep tests about **behaviour, not implementation**: assert the observable (the return
value, the proto sent, the message printed, the trace field), not which private helper
was called. Mocks model the boundary (gRPC client, child process, filesystem), and must
model its real behaviour — a mock that returns stable ids where the real agent churns
them hid a real bug (PILOT-349) behind green tests.

## Which tier

| Behaviour lives in | First test goes in | Run one test |
|---|---|---|
| SDK logic (no device) | `packages/tapsmith/src/__tests__/*.test.ts` (Vitest, mocks) | `cd packages/tapsmith && npx vitest run src/__tests__/<file>.test.ts -t "<name>"` |
| Rust daemon logic | `#[cfg(test)] mod tests` beside the code | `cd packages/tapsmith-core && cargo test <name>` |
| Android agent pure logic | `agent/app/src/test/kotlin/dev/tapsmith/agent/*Test.kt` (JVM) | `cd agent && ./gradlew testDebugUnitTest --tests '*<Class>*'` |
| iOS agent pure logic | `ios-agent/Tests/<Name>Tests/main.swift`, registered in `Tests/run-unit-tests.sh` | `ios-agent/Tests/run-unit-tests.sh` |
| RN hooks package | `packages/tapsmith-react-native/src/__tests__/` | `cd packages/tapsmith-react-native && npx vitest run <file>` |
| UI-mode / trace-viewer panes | `web-tests/` spec (fake UI server or built trace) | `npm run build` in `packages/tapsmith` first, then `cd web-tests && npx playwright test --project=<ui-mode\|trace-viewer> -g "<name>"` |
| e2e helper scripts | `e2e/utils/__tests__/*.test.mjs` | `cd e2e && npm test` |
| On-device behaviour (agent actions, real app, platform quirks) | `e2e/tests/*.test.ts` against `test-app/` (add a screen to the test app if needed) | one file on a device — see below |

Push logic **down** where you can: extract the decision into a pure function the unit
tier can reach, and leave only the wiring for e2e. That is also how the agents got their
host-side unit tests.

**Device-tier red/green.** Check and lease a device first (SKILL.md *Devices*), and
release it when the slice is green. Build what the test needs fresh (SDK `dist/`,
daemon, agent, test-app — stale builds are the commonest false red; see qa-this-branch
`references/probes.md` §0). Then one file:
`cd e2e && node ../packages/tapsmith/dist/cli.js test tests/<file>.test.ts -c tapsmith.config.<android|ios>.mjs`.
Running a single e2e file while iterating is the edit loop, not duplicate coverage.
If no device is free, write the e2e test anyway, mark it unverified-locally in the state
file, and let CI's E2E run be its first red/green — and say so in the PR.

## Package-local checks after each slice

From CLAUDE.md, only for the components you touched:

- SDK: `npm run typecheck && npm run lint && npm run test && npm run knip` in `packages/tapsmith`
- Rust: `cargo fmt -- --check && cargo clippy -- -D warnings && cargo test`
- Android agent: `./gradlew testDebugUnitTest ktlintCheck`
- iOS agent: `ios-agent/Tests/run-unit-tests.sh` (plus the simulator build if you changed
  anything it compiles)
- Proto: `buf lint proto/` and `.github/scripts/check-proto-compat.sh`
- Web tests (if you touched a pane): build, then the affected spec file

Never the full device suite locally — CI runs it on the PR.

## When test-first does not fit

Say which of these applies, in the state file and the PR's "How it was tested":

- **Docs, comments, CI workflow config** — nothing executable to go red. Verify instead
  (run the documented example; read the PR's own CI run for workflow changes).
- **A spike** to learn an unknown API or platform behaviour. Throw the spike away, then
  build test-first from what it taught you.
- **Device-only behaviour with no device free** — test written, first run in CI (above).
- **Pure wiring already covered** by an existing test that goes red if the wiring breaks
  — name that test.

"The test is hard to write" is not on the list. Hard-to-test usually means the logic
needs pulling out of the wiring.

## Proving a regression test earns its keep

For a bug fix, after green: revert just the fix (keep the test), rebuild if the tier
tests `dist/`, watch the test go red, restore. A test that stays green without the fix is
not testing the fix.
